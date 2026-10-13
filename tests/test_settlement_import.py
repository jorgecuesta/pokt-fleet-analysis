"""Independent integration gate failures; no HTTP and no product-data mutations."""
import copy
import gzip
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('import_settlement_month',ROOT/'scripts/import-settlement-month.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
from settlement_product import pack

PILOT=json.loads(gzip.decompress((ROOT/'data/settlement-pilot/settlement-evidence.json.gz').read_bytes()))
RECEIPT=json.loads((ROOT/'data/settlement-pilot/result.json').read_text())
INVESTIGATION=json.loads((ROOT/'data/settlement-pilot/paired-investigation.json').read_text())

class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'review.zip'
    def tearDown(self):self.tmp.cleanup()
    def prior_stage(self):
        earlier=copy.deepcopy(PILOT);receipt=copy.deepcopy(RECEIPT)
        month=copy.deepcopy(earlier['config']);month.update(start='2026-09-06T00:00:00Z')
        earlier['config'].update(start='2026-09-22T00:00:00Z')
        raw=json.dumps(earlier).encode();receipt['config']=copy.deepcopy(earlier['config'])
        receipt['artifactSha256']=hashlib.sha256(raw).hexdigest()
        return raw,earlier,receipt,month
    def test_prior_stage_receipt_and_frame_are_verified(self):
        s.verify_prior_stage(*self.prior_stage())
    def test_prior_stage_requires_its_checksum(self):
        raw,earlier,receipt,month=self.prior_stage();receipt['artifactSha256']='0'*64
        with self.assertRaisesRegex(ValueError,'checksum'):s.verify_prior_stage(raw,earlier,receipt,month)
    def test_prior_stage_rejects_a_changed_frame(self):
        raw,earlier,receipt,month=self.prior_stage();month['cutoff']+=1
        with self.assertRaisesRegex(ValueError,'frame'):s.verify_prior_stage(raw,earlier,receipt,month)
    def test_prior_stage_rejects_a_false_coverage_receipt(self):
        raw,earlier,receipt,month=self.prior_stage();receipt['coverage']['indexedClaims']+=1
        with self.assertRaisesRegex(ValueError,'coverage'):s.verify_prior_stage(raw,earlier,receipt,month)
    def review(self,mutate=None,receipt_change=None,investigation_change=None,packed_change=None):
        evidence=copy.deepcopy(PILOT);receipt=copy.deepcopy(RECEIPT);investigation=copy.deepcopy(INVESTIGATION)
        if mutate:mutate(evidence)
        raw=gzip.compress(json.dumps(evidence,separators=(',',':')).encode(),mtime=0)
        receipt['artifactSha256']=hashlib.sha256(raw).hexdigest()
        if receipt_change:receipt_change(receipt)
        if investigation_change:investigation_change(investigation)
        packed=pack(evidence)
        if packed_change:packed_change(packed)
        readiness={'collectionReconciled':True,'indexedClaims':evidence['coverage']['indexedClaims'],'indexedSettledSessions':evidence['coverage']['indexedSettledSessions']}
        with zipfile.ZipFile(self.path,'w') as z:
            z.writestr('reviewed-pilot/result.json',json.dumps(receipt))
            z.writestr('reviewed-pilot/settlement-evidence.json.gz',raw)
            z.writestr('indexed-settlements-product.json.gz',gzip.compress(json.dumps(packed).encode(),mtime=0))
            z.writestr('investigation/result.json',json.dumps(investigation))
            z.writestr('readiness-report.json',json.dumps(readiness))
        return self.path
    def test_exact_pilot_passes_without_becoming_a_month(self):
        audit,_,_=s.verify(self.review())
        self.assertEqual(audit['claims'],26888);self.assertEqual(audit['sessions'],1327)
        self.assertEqual(audit['sampledCountsChecked'],224);self.assertEqual(audit['coveredOverlapsReconciled'],74)
        self.assertTrue(audit['ownerPartitionsConserveExactly']);self.assertFalse(audit['monthlyActivationReady'])
    def test_pilot_installation_stops_before_any_product_write(self):
        path=self.review()
        with patch.object(sys,'argv',['import-settlement-month.py',str(path)]),patch.object(Path,'write_bytes',side_effect=AssertionError('Product must not be written')):
            with self.assertRaisesRegex(ValueError,'30-day'):
                s.main()
    def test_failed_pair_probe_blocks_even_a_reconciled_receipt(self):
        with self.assertRaisesRegex(ValueError,'investigation'):
            s.verify(self.review(investigation_change=lambda d:d.update(technicalStatus='needs_review')))
    def test_wrong_canonical_checksum_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'checksum'):
            s.verify(self.review(receipt_change=lambda d:d.update(artifactSha256='0'*64)))
    def test_nonlossless_product_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'round-trip'):
            s.verify(self.review(packed_change=lambda d:d['sessions'][0].update(poolUpokt='999999')))
    def test_changed_pool_is_rejected_even_when_packed_hashes_match(self):
        with self.assertRaisesRegex(ValueError,'conserve'):
            s.verify(self.review(mutate=lambda d:d['sessions'][0].update(poolUpokt='999999')))
    def test_unknown_payments_cannot_be_activated(self):
        with self.assertRaisesRegex(ValueError,'attributable'):
            s.verify(self.review(mutate=lambda d:d['sessions'][0].update(payoutStatus='unknown',poolUpokt=None,payouts=[])))
    def test_duplicate_sessions_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'Duplicate session'):
            s.verify(self.review(mutate=lambda d:d['sessions'].append(copy.deepcopy(d['sessions'][0]))))
    def test_outside_utc_window_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'UTC frame'):
            s.verify(self.review(mutate=lambda d:d['sessions'][0].update(endedAt='2026-10-06T00:00:00Z')))
    def test_partial_period_cannot_be_relabelled_monthly(self):
        def change(d):d['config'].update(start='2026-09-06T00:00:00Z',services=sorted(s.SERVICES))
        with self.assertRaisesRegex(ValueError,'Original sampled claim count'):
            s.verify(self.review(mutate=change,receipt_change=lambda d:d['config'].update(start='2026-09-06T00:00:00Z',services=sorted(s.SERVICES))))

if __name__=='__main__':unittest.main()
