"""Failure-oriented checks for staged gates and independent on-chain evidence."""
import base64
import copy
import gzip
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'collector'))
import staged_collection as s
import settlement_collect as original

REFERENCE = original.load_reference(ROOT/'collector/settlement-reference.json.gz')
PILOT_PATH = ROOT/'data/settlement-pilot/result.json' if (ROOT/'data/settlement-pilot/result.json').exists() else ROOT/'reviewed-pilot/result.json'
FIXTURE = json.loads(gzip.decompress((ROOT/'tests/fixtures/settlement-chain-events.json.gz').read_bytes()))


class StagedTests(unittest.TestCase):
    def test_seven_and_month_plans_keep_original_cache_identities(self):
        self.assertEqual(s.plan('7d'), original.plan('pilot'))
        self.assertEqual(s.plan('30d'), original.plan('month'))
        self.assertEqual(s.run_dir(Path('cache'), '30d').name, '884aa1493d5a89a7')

    def test_fortnight_is_same_cutoff_all_services_and_exactly_fourteen_days(self):
        plan = s.plan('14d')
        self.assertEqual((s.dt(plan['endExclusive'])-s.dt(plan['start'])).days, 14)
        self.assertEqual(plan['services'], original.FIXED_SERVICES)
        self.assertEqual(plan['cutoff'], original.CUTOFF)
        self.assertNotEqual(s.run_dir('cache', '14d'), s.run_dir('cache', '30d'))

    def test_pair_selection_keeps_group_roles_and_shared_session_end(self):
        picked = s.choose_pairs(REFERENCE)
        self.assertGreater(picked['covered']['monthlyClaimCount'], 0)
        self.assertEqual(picked['uncovered']['monthlyClaimCount'], 0)
        self.assertEqual(len(picked['pairs']), 3)
        for pair in picked['pairs']:
            self.assertEqual(pair['covered']['sessionEndHeight'], pair['uncovered']['sessionEndHeight'])
            self.assertGreater(pair['covered']['settledClaimCount'], 0)
            self.assertEqual(pair['uncovered']['settledClaimCount'], 0)

    def test_pair_budget_rejects_zero_bool_and_unbounded_counts(self):
        for value in (0, True, 4, -1, 1.5):
            with self.assertRaises(ValueError):
                s.choose_pairs(REFERENCE, value)

    def test_real_abci_events_filter_supplier_reasons_exactly(self):
        rows = s.parse_block_results(FIXTURE['response'], 955813)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]['payoutUpokt'], '17919')
        self.assertTrue(rows[0]['payoutVerified'])
        self.assertEqual(rows[0]['sessionEndHeight'], 955780)

    def test_base64_encoded_abci_attributes_restore_same_evidence(self):
        response = copy.deepcopy(FIXTURE['response'])
        for event in response['result']['finalize_block_events']:
            for attr in event['attributes']:
                attr['key'] = base64.b64encode(attr['key'].encode()).decode()
                attr['value'] = base64.b64encode(attr['value'].encode()).decode()
        self.assertEqual(s.parse_block_results(response, 955813), s.parse_block_results(FIXTURE['response'], 955813))

    def test_wrong_block_and_rpc_error_stop_independent_reconciliation(self):
        with self.assertRaisesRegex(ValueError, 'unexpected'):
            s.parse_block_results(FIXTURE['response'], 955814)
        with self.assertRaisesRegex(ValueError, 'RPC block_results error'):
            s.parse_block_results({'error': {'message': 'pruned height'}}, 955813)

    def test_event_envelope_is_required_even_when_no_settlements_found(self):
        with self.assertRaisesRegex(ValueError, 'envelope'):
            s.parse_block_results({'result': {'height': '955813'}}, 955813)

    def test_duplicate_supplier_session_events_are_rejected(self):
        response = copy.deepcopy(FIXTURE['response'])
        response['result']['finalize_block_events'].append(response['result']['finalize_block_events'][0])
        with self.assertRaisesRegex(ValueError, 'Duplicate on-chain'):
            s.parse_block_results(response, 955813)

    def test_duplicate_attributes_and_missing_reason_details_are_rejected(self):
        event = copy.deepcopy(FIXTURE['response']['result']['finalize_block_events'][0])
        event['attributes'].append(event['attributes'][0])
        with self.assertRaisesRegex(ValueError, 'Duplicate settlement-event'):
            s.chain_event(event, 955813)
        event = copy.deepcopy(FIXTURE['response']['result']['finalize_block_events'][0])
        event['attributes'] = [a for a in event['attributes'] if a['key'] != 'reward_distribution_detailed']
        with self.assertRaisesRegex(ValueError, 'Detailed'):
            s.chain_event(event, 955813)

    def test_failed_transaction_events_do_not_establish_a_payment(self):
        event = FIXTURE['response']['result']['finalize_block_events'][0]
        response = {'result': {'height': '955813', 'finalize_block_events': [],
                               'txs_results': [{'code': 5, 'events': [event]}]}}
        self.assertEqual(s.parse_block_results(response, 955813), [])

    def test_unknown_distribution_reason_is_retained_as_unverified(self):
        event = copy.deepcopy(FIXTURE['response']['result']['finalize_block_events'][0])
        for attr in event['attributes']:
            if attr['key'] == 'reward_distribution_detailed':
                transfers = json.loads(attr['value'])
                transfers.append({'op_reason': 'UNSPECIFIED', 'recipient_address': 'unknown', 'amount': '1upokt'})
                attr['value'] = json.dumps(transfers)
        row = s.chain_event(event, 955813)
        self.assertFalse(row['payoutVerified'])
        self.assertFalse(s.reconcile_control([row], [row])['passed'])

    def test_coin_parser_preserves_large_integers_and_rejects_other_denoms(self):
        self.assertEqual(s.coin_upokt('90071992547409931234upokt'), 90071992547409931234)
        for value in ('-1upokt', '0.1upokt', '1pokt', 1, '1upokt '):
            with self.assertRaises(ValueError):
                s.coin_upokt(value)

    def test_control_must_have_exact_on_chain_identity_and_amount(self):
        rows = s.parse_block_results(FIXTURE['response'], 955813)
        self.assertTrue(s.reconcile_control(rows, rows)['passed'])
        altered = copy.deepcopy(rows)
        altered[0]['payoutUpokt'] = str(int(altered[0]['payoutUpokt'])+1)
        self.assertFalse(s.reconcile_control(rows, altered)['passed'])
        self.assertFalse(s.reconcile_control(rows, rows[1:])['passed'])
        self.assertFalse(s.reconcile_control([], rows)['passed'])

    def test_negative_probe_never_certifies_whole_group_or_fills_zero(self):
        groups = [{'kind': 'covered', 'originalCutoffClaims': 100, 'laterCutoffClaims': 100},
                  {'kind': 'uncovered', 'originalCutoffClaims': 0, 'laterCutoffClaims': 0}]
        result = s.diagnose_missingness(groups, [{'control': {'passed': True}}], [], [])
        self.assertEqual(result['technicalStatus'], 'passed')
        self.assertFalse(result['wholeGroupCauseEstablished'])
        self.assertIn('unresolved', result['missingPaymentFinding'])

    def test_positive_indexer_gap_blocks_expansion(self):
        result = s.diagnose_missingness([], [{'control': {'passed': True}}], [{'supplierId': 'missing'}], [])
        self.assertEqual(result['technicalStatus'], 'needs_review')
        self.assertFalse(result['safeToCollectIndexedSettlements'])

    def test_later_cutoff_settlements_do_not_rewrite_original_scope(self):
        result = s.diagnose_missingness([{'kind': 'uncovered', 'originalCutoffClaims': 0, 'laterCutoffClaims': 7}],
                                       [{'control': {'passed': True}}], [], [])
        self.assertIn('after the original cutoff', result['missingPaymentFinding'])
        self.assertFalse(result['wholeGroupCauseEstablished'])

    def test_changed_original_cutoff_and_api_errors_require_review(self):
        result = s.diagnose_missingness([{'kind': 'uncovered', 'originalCutoffClaims': 4, 'laterCutoffClaims': 4}],
                                       [{'control': {'passed': True}}], [], [])
        self.assertFalse(result['safeToCollectIndexedSettlements'])
        result = s.diagnose_missingness([], [], [], [{'message': 'HTTP 403'}])
        self.assertFalse(result['safeToCollectIndexedSettlements'])

    def test_investigation_failure_is_saved_without_claiming_success(self):
        class Blocked:
            metrics = []
            def gql(self, *args, **kwargs):
                raise RuntimeError('HTTP 403: example access failure')
        with tempfile.TemporaryDirectory() as folder:
            result = s.investigate(folder, ROOT/'collector/settlement-reference.json.gz', client=Blocked(), progress=lambda _: None)
            saved = s.read_json(Path(folder)/'investigation/result.json')
            self.assertEqual(result['technicalStatus'], 'needs_review')
            self.assertEqual(result, saved)
            self.assertIn('HTTP 403', saved['errors'][0]['message'])

    def test_complete_paired_probe_detects_a_realistic_unindexed_payment(self):
        picked = copy.deepcopy(s.choose_pairs(REFERENCE, 1))
        control = picked['pairs'][0]['covered']
        missing = picked['pairs'][0]['uncovered']
        control['settledClaimCount'] = 1
        height = control['sessionEndHeight']+33
        base_event = copy.deepcopy(FIXTURE['response']['result']['finalize_block_events'][0])
        supplier = REFERENCE['supplierIds'][control['members'][0][0]]
        def event_for(session):
            event = copy.deepcopy(base_event)
            values = {'session_id': session['id'], 'service_id': 'eth', 'application_address': session['applicationId'],
                      'supplier_operator_address': supplier, 'session_end_block_height': str(session['sessionEndHeight'])}
            for attr in event['attributes']:
                if attr['key'] in values:
                    attr['value'] = json.dumps(values[attr['key']])
            return event
        claim = {'id': 'claim-1', 'supplierId': supplier, 'serviceId': 'eth', 'applicationId': control['applicationId'],
                 'sessionId': control['id'], 'sessionEndHeight': str(control['sessionEndHeight']), 'blockId': str(height),
                 'settledAmount': '23265', 'settledDenom': 'upokt', 'block': {'timestamp': control['observedAt']},
                 'allTransfers': {'totalCount': 6}, 'unknownTransfers': {'totalCount': 0},
                 'supplierTransfers': {'totalCount': 2, 'aggregates': {'sum': {'amount': '17919'}}},
                 'relayTransfers': {'totalCount': 2, 'aggregates': {'sum': {'amount': '17919'}}},
                 'globalTransfers': {'totalCount': 0, 'aggregates': {'sum': {'amount': None}}}}
        class Source:
            metrics = []
            def gql(self, query, **variables):
                if '_metadata' in query:
                    return {'_metadata': {'chain': 'pocket', 'lastProcessedHeight': 959000}}
                filt = variables['filter']
                known = filt.get('applicationId', {}).get('equalTo') == control['applicationId'] or filt.get('sessionId', {}).get('equalTo') == control['id']
                if query == original.COUNT_QUERY:
                    return {'eventClaimSettleds': {'totalCount': int(known)}}
                return {'eventClaimSettleds': {'nodes': [claim] if known else [], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}}
            def rest(self, *args, **kwargs):
                return {'block': {'header': {'chain_id': 'pocket', 'height': '959000'}}}
            def request(self, url, **kwargs):
                if url.endswith('/status'):
                    return {'result': {'node_info': {'network': 'pocket'}}}
                return {'result': {'height': str(height), 'finalize_block_events': [event_for(control), event_for(missing)]}}
        with tempfile.TemporaryDirectory() as folder, patch.object(s, 'choose_pairs', return_value=picked), \
                patch.object(original, 'resolve_boundaries', return_value={'start': {'height': 942171}, 'end': {'height': 952159}}):
            result = s.investigate(folder, ROOT/'collector/settlement-reference.json.gz', pair_count=1, client=Source(), progress=lambda _: None)
            self.assertEqual(result['errors'], [])
            self.assertTrue(result['checks'][0]['control']['passed'])
            self.assertEqual(len(result['unindexedOnChainEvents']), 1)
            self.assertTrue(result['positiveCauseEvidenceFound'])
            self.assertFalse(result['safeToCollectIndexedSettlements'])
            self.assertFalse(result['wholeGroupCauseEstablished'])

    def test_stage14_without_investigation_stops_before_any_http(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(s.Client, 'request', side_effect=AssertionError('HTTP must not start')):
            with self.assertRaisesRegex(ValueError, 'investigation'):
                s.execute('14d', folder, ROOT/'collector/settlement-reference.json.gz', PILOT_PATH)

    def test_month_without_fortnight_proof_stops_before_any_http(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(s, 'require_investigation'), patch.object(s.Client, 'request', side_effect=AssertionError('HTTP must not start')):
            with self.assertRaises(FileNotFoundError):
                s.execute('30d', folder, ROOT/'collector/settlement-reference.json.gz', PILOT_PATH)

    def test_fortnight_artifact_tampering_and_wrong_scope_fail_gate(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            evidence = {'codec': 'settlement-session-v1', 'config': s.plan('14d'),
                        'coverage': {'indexedClaims': 2, 'unknownDistributionClaims': 0}}
            artifact = folder/'settlement-evidence.json.gz'
            original.atomic_json(artifact, evidence)
            proof = {'status': 'reconciled', 'config': s.plan('14d'), 'overlap': {'passed': True},
                     'coverage': evidence['coverage'], 'artifact': artifact.name,
                     'artifactSha256': hashlib.sha256(artifact.read_bytes()).hexdigest()}
            original.atomic_json(folder/'result.json', proof)
            self.assertEqual(s.verify_receipt(folder/'result.json', '14d'), proof)
            artifact.write_bytes(artifact.read_bytes()+b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                s.verify_receipt(folder/'result.json', '14d')

    def test_investigation_receipt_cannot_be_reused_for_another_scope(self):
        picked = s.choose_pairs(REFERENCE)
        report = {'version': s.VERSION, 'config': s.plan('7d'), 'referenceProductSha256': original.PRODUCT_SHA256,
                  'selectedGroups': {k: picked[k] for k in ('covered', 'uncovered')}, 'technicalStatus': 'passed',
                  'safeToCollectIndexedSettlements': True, 'checks': [{'control': {'passed': True}}], 'errors': [], 'unindexedOnChainEvents': []}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'investigation/result.json'
            original.atomic_json(path, report)
            self.assertEqual(s.require_investigation(folder, ROOT/'collector/settlement-reference.json.gz'), report)
            report['config']['cutoff'] += 1
            original.atomic_json(path, report)
            with self.assertRaisesRegex(ValueError, 'needs review'):
                s.require_investigation(folder, ROOT/'collector/settlement-reference.json.gz')

    def test_parallel_collector_is_rejected_and_interrupt_releases_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(KeyboardInterrupt):
                with s.single_collector(folder, '14d'):
                    with self.assertRaisesRegex(RuntimeError, 'Another staged run'):
                        with s.single_collector(folder, '30d'):
                            pass
                    raise KeyboardInterrupt()
            self.assertFalse((Path(folder)/'.staged-collector.lock').exists())

    def test_progress_reader_reads_existing_checkpoint_without_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = s.run_dir(folder, '30d')
            database = original.connect(directory/'claims.sqlite3', s.plan('30d'))
            database.execute("INSERT INTO services VALUES('arb-one',102999,'collecting')")
            database.commit()
            database.close()
            before = hashlib.sha256((directory/'claims.sqlite3').read_bytes()).hexdigest()
            snapshot = s.progress_snapshot(folder, '30d')
            self.assertEqual(snapshot['downloadedClaims'], 0)
            self.assertEqual(snapshot['services'][0]['expectedClaims'], 102999)
            self.assertEqual(hashlib.sha256((directory/'claims.sqlite3').read_bytes()).hexdigest(), before)

    def test_included_pilot_reuse_has_no_repeat_download(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(original, 'run', side_effect=AssertionError('Do not recollect pilot')), \
                patch.object(s, 'investigate', return_value={'technicalStatus': 'passed'}):
            result = s.execute('7d', folder, ROOT/'collector/settlement-reference.json.gz', PILOT_PATH, progress=lambda _: None)
            self.assertEqual(result['receipt']['coverage']['indexedClaims'], 26888)

    def test_reconciled_collection_does_not_unlock_network_or_predictions(self):
        result = s.readiness(s.read_json(PILOT_PATH))
        self.assertTrue(result['collectionReconciled'])
        self.assertFalse(result['fullNetworkEarningsReady'])
        self.assertFalse(result['historicalPredictionAutomaticallyEnabled'])
        self.assertEqual(result['originalComparableSampledSessions'], 1652)


if __name__ == '__main__':
    unittest.main()
