"""Failure, resume and attribution cases for the separate settlement path."""
import copy
import gzip
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"collector"))
import settlement_collect as s
sys.path.insert(0,str(ROOT/"analysis"))
from settlement_analysis import analyze
from settlement_product import pack, unpack
from pokt_live_collector import address_parts

REFERENCE=s.load_reference(ROOT/"collector/settlement-reference.json.gz")
ORIGINAL=next(r for r in REFERENCE["sessions"] if r["serviceId"]=="eth" and r["payoutStatus"]=="complete" and r["observedAt"]>="2026-09-29")
SUPPLIER=REFERENCE["supplierIds"][ORIGINAL["payouts"][0][0]]
OWNER=REFERENCE["ownerIds"][ORIGINAL["members"][0][1]]
CONFIG=s.plan("pilot")
BOUNDS={"start":{"height":940000},"end":{"height":952159}}

def claim(i=1,amount=27):
    conn=lambda n,a:{"totalCount":n,"aggregates":{"sum":{"amount":str(a) if n else None}}}
    return {"id":f"951000-finalize_block-{i}","supplierId":SUPPLIER,"serviceId":"eth","applicationId":"application",
            "sessionId":f"{i:064x}","sessionEndHeight":"950920","blockId":"951000",
            "numEstimatedRelays":"10","numEstimatedComputedUnits":"100","settledAmount":"100",
            "settledDenom":"upokt","block":{"timestamp":"2026-10-05T05:00:00Z"},
            "allTransfers":{"totalCount":5},"unknownTransfers":{"totalCount":0},
            "supplierTransfers":conn(2,amount),"relayTransfers":conn(1,amount-2),"globalTransfers":conn(1,2)}

class Pages:
    def __init__(self,pages,total=None,fail=None):
        self.pages=pages;self.total=sum(len(p[0]) for p in pages) if total is None else total
        self.after=[];self.fail=fail
    def gql(self,query,**v):
        if query==s.COUNT_QUERY:return {"eventClaimSettleds":{"totalCount":self.total}}
        self.after.append(v["after"])
        i=0 if v["after"] is None else int(v["after"])
        if self.fail==i:raise RuntimeError("HTTP 429: retry budget exhausted")
        rows,next_=self.pages[i]
        return {"eventClaimSettleds":{"totalCount":self.total,"nodes":copy.deepcopy(rows),
             "pageInfo":{"hasNextPage":next_ is not None,"endCursor":str(next_) if next_ is not None else None}}}

class SettlementTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=ROOT)
        self.db=s.connect(Path(self.tmp.name)/"claims.sqlite3",CONFIG)
    def tearDown(self):
        self.db.close();self.tmp.cleanup()
    def download(self,client):
        return s.download_service(client,self.db,CONFIG,"eth",BOUNDS,lambda _:None)

    def packing_example(self):
        return {"codec":"settlement-session-v1","supplierIds":["a","b"],"ownerIds":["old","new"],
            "endpointCatalog":[{"id":"e1","registrableDomain":"a.example"},{"id":"e2","registrableDomain":"b.example"}],
            "sessions":[{"id":"first","serviceId":"eth","endedAt":"2026-10-04T00:00:00Z","selectedCount":2,
                "members":[[0,0,["e1","e2"]],[1,1,["e2"]]],"payouts":[[0,str(10**25+27)],[1,"0"]],
                "poolUpokt":str(10**25+27),"payoutStatus":"verified"},
                {"id":"later","serviceId":"eth","endedAt":"2026-10-05T00:00:00Z","selectedCount":2,
                "members":[[0,1,["e2"]],[1,1,["e2"]]],"payouts":[],"poolUpokt":None,"payoutStatus":"unknown"}]}

    def test_lossless_packing_retains_owner_endpoint_changes_and_unknowns(self):
        original=self.packing_example();before=copy.deepcopy(original);packed=pack(original)
        self.assertEqual(original,before);restored=unpack(packed);self.assertEqual(restored,original)
        for dimension in ['owner','domain','supplier']:
            self.assertEqual(analyze(restored,dimension),analyze(original,dimension))
        self.assertEqual(packed['sessions'][1]['poolUpokt'],None)
        self.assertNotEqual(packed['sessions'][0]['members'][0],packed['sessions'][1]['members'][0])

    def test_corrupt_packed_indices_are_rejected(self):
        for value in [-1,1.5,True,1000000]:
            packed=pack(self.packing_example());packed['sessions'][0]['members'][0]=value
            with self.assertRaisesRegex(ValueError,'packed session'):unpack(packed)

    def test_database_timeout_retries_the_same_cursor_with_smaller_pages(self):
        calls=[]
        class Busy:
            def gql(self,query,**v):
                calls.append((v['after'],v['first']))
                if len(calls)==1:
                    raise ValueError('GraphQL errors: canceling statement due to statement timeout; code 57014')
                return {'eventClaimSettleds':{'nodes':[],'pageInfo':{'hasNextPage':False,'endCursor':None}}}
        with patch.object(s.time,'sleep'):
            _,size=s.claim_page(Busy(),{'after':'retained-cursor'},500,lambda _:None)
        self.assertEqual(calls,[('retained-cursor',500),('retained-cursor',250)])
        self.assertEqual(size,250)

    def test_database_timeout_has_a_bounded_retry_budget(self):
        calls=[]
        class Busy:
            def gql(self,query,**v):
                calls.append(v['first'])
                raise ValueError('GraphQL errors: canceling statement due to statement timeout; code 57014')
        with patch.object(s.time,'sleep'):
            with self.assertRaisesRegex(ValueError,'timeout'):s.claim_page(Busy(),{'after':None},500,lambda _:None)
        self.assertEqual(calls,[500,250,125,62])

    def test_schema_errors_are_not_retried_or_hidden(self):
        calls=[]
        class WrongSchema:
            def gql(self,query,**v):
                calls.append(v['first']);raise ValueError('GraphQL errors: Unknown field')
        with self.assertRaisesRegex(ValueError,'Unknown field'):
            s.claim_page(WrongSchema(),{'after':None},500,lambda _:None)
        self.assertEqual(calls,[500])

    def test_plans_keep_the_reviewed_dates_cutoff_and_service_set(self):
        self.assertEqual(s.plan()["services"],["eth"]);self.assertEqual(s.plan()["start"],"2026-09-29T00:00:00Z")
        self.assertEqual(s.plan("month")["services"],s.FIXED_SERVICES)
        self.assertEqual(s.plan("month")["start"],s.MONTH_START)

    def test_claim_scope_is_not_restricted_to_sampled_applications(self):
        f=s.claim_filter(CONFIG,"eth",BOUNDS)
        self.assertNotIn("appId",f);self.assertNotIn("applicationId",f)
        self.assertNotIn("sessionId",f);self.assertEqual(f["blockId"]["lessThanOrEqualTo"],"955836")

    def test_distributions_use_supplier_transfers_not_whole_claim_value(self):
        r=s.normalize_claim(claim(),CONFIG,"eth",BOUNDS)
        self.assertEqual(r["payoutUpokt"],"27");self.assertTrue(r["payoutVerified"])

    def test_large_integer_amounts_are_exact(self):
        value=10**25+27;r=s.normalize_claim(claim(amount=value),CONFIG,"eth",BOUNDS)
        self.assertEqual(int(r["payoutUpokt"]),value)

    def test_unattributed_distributions_remain_unknown(self):
        raw=claim();raw["unknownTransfers"]["totalCount"]=1
        self.assertFalse(s.normalize_claim(raw,CONFIG,"eth",BOUNDS)["payoutVerified"])

    def test_distribution_reason_mismatch_is_rejected(self):
        raw=claim();raw["relayTransfers"]["aggregates"]["sum"]["amount"]="3"
        with self.assertRaisesRegex(ValueError,"reconcile"):s.normalize_claim(raw,CONFIG,"eth",BOUNDS)

    def test_missing_aggregate_is_rejected(self):
        raw=claim();raw["supplierTransfers"]["aggregates"]["sum"]["amount"]=None
        with self.assertRaisesRegex(ValueError,"aggregate"):s.normalize_claim(raw,CONFIG,"eth",BOUNDS)

    def test_out_of_scope_claims_are_rejected(self):
        for field,value in [("serviceId","base"),("sessionEndHeight","952159"),("blockId","955837"),("settledDenom","uatom")]:
            raw=claim();raw[field]=value
            with self.assertRaises(ValueError):s.normalize_claim(raw,CONFIG,"eth",BOUNDS)

    def test_pages_and_resume_handle_a_short_intermediate_page(self):
        p=Pages([([claim(1)],1),([claim(2)],None)])
        self.assertEqual(self.download(p),2);s.verify_database(self.db)
        again=Pages([] ,total=2);self.assertEqual(self.download(again),2);self.assertEqual(again.after,[])

    def test_failure_resumes_from_the_committed_cursor(self):
        pages=[([claim(1)],1),([claim(2)],None)]
        with self.assertRaisesRegex(RuntimeError,"429"):self.download(Pages(pages,fail=1))
        self.assertEqual(self.db.execute("SELECT count(*) FROM claims").fetchone()[0],1)
        retry=Pages(pages);self.download(retry);self.assertEqual(retry.after,["1"]);s.verify_database(self.db)

    def test_duplicate_claims_rollback_the_entire_page(self):
        with self.assertRaises(sqlite3.IntegrityError):self.download(Pages([([claim(1),claim(1)],None)]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM claims").fetchone()[0],0)

    def test_two_claims_for_one_supplier_session_are_rejected(self):
        a,b=claim(1),claim(2);b["sessionId"]=a["sessionId"]
        with self.assertRaises(sqlite3.IntegrityError):self.download(Pages([([a,b],None)]))

    def test_truncated_connection_is_rejected(self):
        with self.assertRaisesRegex(ValueError,"pagination count"):self.download(Pages([([claim()],None)],total=2))

    def test_changed_count_under_cutoff_is_rejected_on_resume(self):
        self.download(Pages([([claim()],None)]))
        with self.assertRaisesRegex(ValueError,"changed"):self.download(Pages([],total=2))

    def test_modified_cached_claim_is_detected(self):
        self.download(Pages([([claim()],None)]))
        self.db.execute("UPDATE claims SET json=replace(json,'\"27\"','\"28\"')");self.db.commit()
        with self.assertRaisesRegex(ValueError,"hash"):s.verify_database(self.db)

    def test_resume_rejects_a_different_frame(self):
        with self.assertRaisesRegex(ValueError,"another plan"):s.connect(Path(self.tmp.name)/"claims.sqlite3",s.plan("month"))

    def test_reference_wrong_cutoff_is_rejected(self):
        target=Path(self.tmp.name)/"ref.json";r=copy.deepcopy(REFERENCE);r["cutoff"]+=1
        target.write_text(json.dumps(r))
        with self.assertRaisesRegex(ValueError,"exact"):s.load_reference(target)

    def test_month_requires_a_successful_live_pilot(self):
        with self.assertRaisesRegex(ValueError,"seven-day"):s.run(Path(self.tmp.name),"month",ROOT/"collector/settlement-reference.json.gz")

    def test_month_requires_the_pilot_artifact_before_http(self):
        path=Path(self.tmp.name)/"result.json"
        path.write_text(json.dumps({"status":"reconciled","config":s.plan(),"overlap":{"passed":True},
            "coverage":{"unknownDistributionClaims":0},"artifact":"absent.json.gz","artifactSha256":"0"*64}))
        with patch.object(s,"Client",side_effect=AssertionError("HTTP must not start")):
            with self.assertRaisesRegex(ValueError,"evidence is missing"):
                s.run(Path(self.tmp.name),"month",ROOT/"collector/settlement-reference.json.gz",path)

    def test_month_rejects_modified_pilot_bytes_before_http(self):
        path=Path(self.tmp.name)/"result.json"
        (path.parent/"evidence.json.gz").write_bytes(b"modified after reconciliation")
        path.write_text(json.dumps({"status":"reconciled","config":s.plan(),"overlap":{"passed":True},
            "coverage":{"unknownDistributionClaims":0},"artifact":"evidence.json.gz","artifactSha256":"0"*64}))
        with patch.object(s,"Client",side_effect=AssertionError("HTTP must not start")):
            with self.assertRaisesRegex(ValueError,"evidence checksum"):
                s.run(Path(self.tmp.name),"month",ROOT/"collector/settlement-reference.json.gz",path)

    def test_monthly_known_counts_reconcile_and_extra_apps_are_retained(self):
        evidence={"groups":[{**g,"claimCount":g["monthlyClaimCount"]} for g in REFERENCE["monthlyGroups"] if g["monthlyClaimCount"]]}
        evidence["groups"].append({"serviceId":"eth","applicationId":"new-between-observations","claimCount":7})
        result=s.reconcile_monthly_counts(evidence,REFERENCE)
        self.assertEqual(result["knownGroupClaimRecords"],851096);self.assertEqual(len(result["additionalApplicationGroups"]),1)
        evidence["groups"][0]["claimCount"]+=1
        with self.assertRaises(ValueError):s.reconcile_monthly_counts(evidence,REFERENCE)

    def test_utc_boundary_is_selected_by_numeric_height(self):
        class Boundary:
            def gql(self,q):return {"start":{"totalCount":2,"pageInfo":{"hasNextPage":False},"nodes":[{"id":"10","timestamp":"2026-09-29T00:00:20Z"},{"id":"9","timestamp":"2026-09-29T00:00:10Z"}]},"end":{"totalCount":1,"pageInfo":{"hasNextPage":False},"nodes":[{"id":"20","timestamp":"2026-10-06T00:00:10Z"}]}}
        self.assertEqual(s.resolve_boundaries(Boundary(),CONFIG)["start"]["height"],9)

    def test_live_recorded_historical_roster_replays_without_network(self):
        fixture=json.loads(gzip.decompress((ROOT/'tests/fixtures/settlement-roster.json.gz').read_bytes()))
        calls=[]
        class Archive:
            def rest(self,path,height=None,**kwargs):
                calls.append((path,height,kwargs))
                if path.endswith('get_session'):return copy.deepcopy(fixture['roster']['response'])
                if path.endswith('params'):return copy.deepcopy(fixture['cap']['response'])
                return copy.deepcopy(fixture['block']['response'])
        h=fixture['roster']['response']['session']['header']
        session={'id':h['session_id'],'serviceId':h['service_id'],'applicationId':h['application_address'],'endHeight':int(h['session_end_block_height'])}
        result=s.historical_roster(Archive(),session,CONFIG,verify_cap=True)
        self.assertEqual(len(result['members']),50)
        self.assertEqual(calls[0][1],session['endHeight'])
        self.assertEqual(calls[1][1],int(h['session_start_block_height'])-1)
        self.assertTrue(all(m['endpoints'] for m in result['members']))

    def test_historical_roster_identity_mismatch_stops_collection(self):
        fixture=json.loads(gzip.decompress((ROOT/'tests/fixtures/settlement-roster.json.gz').read_bytes()))
        class Archive:
            def rest(self,*a,**k):return fixture['roster']['response']
        with self.assertRaisesRegex(ValueError,'identities'):
            s.historical_roster(Archive(),{'id':'wrong','serviceId':'eth','applicationId':'wrong','endHeight':942180},CONFIG)

    def test_compact_evidence_keeps_an_unknown_session_out_of_earnings(self):
        raw=claim();raw['unknownTransfers']['totalCount']=1
        self.download(Pages([([raw],None)]))
        roster={'id':raw['sessionId'],'serviceId':'eth','applicationId':'application','endHeight':950920,'endedAt':'2026-10-05T03:00:00Z','selectedCount':1,
          'members':[{'id':SUPPLIER,'owner':OWNER,'endpoints':[]}]}
        self.db.execute('INSERT INTO rosters VALUES(?,?,?)',(roster['id'],json.dumps(roster),s.digest(roster)));self.db.commit()
        evidence=s.compact_evidence(self.db,CONFIG)
        self.assertEqual(evidence['sessions'][0]['payoutStatus'],'unknown')
        self.assertIsNone(evidence['sessions'][0]['poolUpokt']);self.assertEqual(evidence['sessions'][0]['payouts'],[])
        self.assertEqual(evidence['coverage']['unknownDistributionClaims'],1)

    def test_exact_original_payout_and_membership_overlap(self):
        original=copy.deepcopy(ORIGINAL);sid=original['id'];owners=REFERENCE['ownerIds'];ids=REFERENCE['supplierIds']
        for pos,(idx,value) in enumerate(original['payouts']):
            r=claim(pos+1,int(value));r.update(sessionId=sid,supplierId=ids[idx],applicationId=original['applicationId'],sessionEndHeight=str(original['sessionEndHeight']))
            r=s.normalize_claim(r,CONFIG,'eth',BOUNDS)
            self.db.execute('INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?)',(r['id'],sid,'eth',r['applicationId'],int(r['sessionEndHeight']),r['supplierId'],json.dumps(r),0,pos))
        roster={'id':sid,'members':[{'id':ids[i],'owner':owners[o],'endpoints':[{'id':eid} for eid in eps]} for i,o,eps in original['members']]}
        self.db.execute('INSERT INTO rosters VALUES(?,?,?)',(sid,json.dumps(roster),s.digest(roster)));self.db.commit()
        reference={**REFERENCE,'sessions':[original]}
        self.assertTrue(s.reconcile_reference(self.db,CONFIG,reference)['passed'])
        roster['members'][0]['owner']=owners[(original['members'][0][1]+1)%len(owners)]
        self.db.execute('UPDATE rosters SET json=?,hash=? WHERE session=?',(json.dumps(roster),s.digest(roster),sid));self.db.commit()
        result=s.reconcile_reference(self.db,CONFIG,reference)
        self.assertFalse(result['passed']);self.assertEqual(len(result['membershipDifferences']),1)

    def test_block_timestamp_batches_reject_missing_and_out_of_scope_rows(self):
        class Blocks:
            def gql(self,q,**v):
                return {'blocks':{'totalCount':2,'pageInfo':{'hasNextPage':False},'nodes':[{'id':'950920','timestamp':'2026-10-05T03:00:00Z'},{'id':'950940','timestamp':'2026-10-05T03:20:00Z'}]}}
        result=s.block_times(Blocks(),[950920,950940],CONFIG);self.assertEqual(len(result),2)
        with self.assertRaisesRegex(ValueError,'incomplete'):s.block_times(Blocks(),[950920],CONFIG)

    def test_owner_partitions_use_exact_equal_share_ratios_and_domains_overlap(self):
        evidence={'codec':'settlement-session-v1','supplierIds':['a','b'],'ownerIds':['one','two'],
          'endpointCatalog':[{'id':'e1','registrableDomain':'a.example'},{'id':'e2','registrableDomain':'b.example'}],
          'sessions':[{'id':'s','serviceId':'eth','endedAt':'2026-10-01T01:00:00Z','selectedCount':2,
            'members':[[0,0,['e1','e2']],[1,1,['e2']]],'payouts':[[0,'30'],[1,'70']],'poolUpokt':'100','payoutStatus':'verified'}]}
        result=analyze(evidence,'owner');by={r['label']:r for r in result['rows']}
        self.assertEqual(sum(int(r['actualUpokt']) for r in result['rows']),100)
        self.assertEqual(by['one']['equalShareUpokt'],{'numerator':'50','denominator':'1'})
        self.assertEqual(by['one']['fScore'],.6);self.assertAlmostEqual(by['one']['differencePercent'],-40)
        domains=analyze(evidence,'domain');self.assertTrue(domains['overlapping'])
        self.assertEqual(sum(int(r['actualUpokt']) for r in domains['rows']),130)

    def test_inconsistent_settlement_pool_is_rejected_before_analysis(self):
        e={'codec':'settlement-session-v1','supplierIds':['a'],'ownerIds':['one'],'endpointCatalog':[],
           'sessions':[{'serviceId':'eth','endedAt':'2026-10-01','selectedCount':1,'members':[[0,0,[]]],'payouts':[[0,'7']],'poolUpokt':'9','payoutStatus':'verified'}]}
        with self.assertRaisesRegex(ValueError,'pool'):analyze(e)


if __name__=="__main__":unittest.main()
