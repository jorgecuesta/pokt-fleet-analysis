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
import session_catalog as catalog
sys.path.insert(0,str(ROOT/"analysis"))
from settlement_analysis import analyze
from settlement_product import pack, unpack
from pokt_live_collector import address_parts

REFERENCE=s.load_reference(ROOT/"collector/settlement-reference.json.gz")
ORIGINAL=next(r for r in REFERENCE["sessions"] if r["serviceId"]=="eth" and r["payoutStatus"]=="complete" and r["observedAt"]>="2026-09-29")
SUPPLIER=REFERENCE["supplierIds"][ORIGINAL["payouts"][0][0]]
OWNER=REFERENCE["ownerIds"][ORIGINAL["members"][0][1]]
CONFIG=s.plan("pilot")
BOUNDS={"start":{"height":940000,"timestamp":"2026-09-29T00:00:10Z"},"end":{"height":952159,"timestamp":"2026-10-06T00:00:10Z"}}

RANGE={"requested_from":"2026-09-28T23:00:10Z","requested_to":"2026-10-06T02:00:10Z","covered_from":"2026-09-28T23:00:10Z",
       "covered_to":"2026-10-06T02:00:10Z","gaps":[],"end_inclusive":False}

def row(i=1,amount=27,start=950901,state="paid",started="2026-10-05T03:00:00+00:00"):
    """One getSessionRostersJson row: a one-member roster settled at 951000."""
    return {"session_id":f"{i:064x}","service_id":"eth","application_id":"application","start_height":str(start),"start_time":started,
            "end_height":str(start+19),"phase":"settled","settled_height":"951000","money_missing":False,
            "candidates":"1","roster_size":"1","claimed":"1","paid_upokt":str(amount),"member_ids":[SUPPLIER],
            "member_states":[state],"member_paid_upokt":[str(amount)],"member_owner_ids":[OWNER],"member_domains":[None]}

class Pages:
    """Session catalog pages keyed by the before_* cursor of the page before."""
    def __init__(self,pages,fail=None,coverage=RANGE,network=None):
        self.pages=pages;self.before=[];self.fail=fail;self.coverage=coverage;self.network=network
    def gql(self,query,**v):
        if query==catalog.NETWORK_QUERY:
            # The catalog's own total: every settled seat of the sessions started in the window.
            seats=self.network if self.network is not None else s.settled_seats([r for rows,_ in self.pages for r in rows],v["a"],v["b"])
            return {"getNetworkSessionsJson":{"range":{**self.coverage,"covered_from":v["a"],"covered_to":v["b"]},
                    "data":[{"service_id":"eth","paid":str(seats),"settled_zero":"0","active":"0","unresolved":"0"}]}}
        if query==catalog.BLOCKS_QUERY:
            ids=v["filter"]["id"]["in"]
            return {"blocks":{"totalCount":len(ids),"pageInfo":{"hasNextPage":False},
                    "nodes":[{"id":h,"timestamp":"2026-10-05T05:00:00Z"} for h in ids]}}
        key=None if v["h"] is None else f"{v['h']}:{v['sid']}"
        self.before.append(key)
        i=0 if key is None else next(n+1 for n,(rows,_) in enumerate(self.pages) if rows and f"{rows[-1]['start_height']}:{rows[-1]['session_id']}"==key)
        if self.fail==i:raise RuntimeError("HTTP 429: retry budget exhausted")
        return {"getSessionRostersJson":{"range":self.coverage,"data":copy.deepcopy(self.pages[i][0])}}

def older(rows):
    """Close a last page with a session that ends before the window, as the catalog's one-hour margin does."""
    return rows+[row(10**6,start=939000,started="2026-09-28T23:30:00+00:00")]

class SettlementTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=ROOT)
        self.db=s.connect(Path(self.tmp.name)/"claims.sqlite3",CONFIG)
        # Four sessions per catalog page keep the paging cases small.
        self.sizes=[patch.object(s,"PAGE_SIZE",4),patch.object(catalog,"PAGE_SIZE",4)]
        for p in self.sizes:p.start()
    def tearDown(self):
        for p in self.sizes:p.stop()
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

    def test_config_history_timeout_is_retried_once_as_two_halves(self):
        calls=[]
        class Busy:
            def gql(self,query,**v):
                calls.append(len(v['ids']))
                if len(calls)==1:
                    raise ValueError('GraphQL errors: canceling statement due to statement timeout; code 57014')
                return {'getSuppliersConfigHistoryJson':[]}
        s.supplier_configs(Busy(),[(f'pokt{i}','eth') for i in range(200)],lambda _:None)
        self.assertEqual(calls,[200,100,100])
        calls.clear()
        class AlwaysBusy(Busy):
            def gql(self,query,**v):
                calls.append(len(v['ids']));raise ValueError('GraphQL errors: canceling statement due to statement timeout; code 57014')
        with self.assertRaisesRegex(ValueError,'timeout'):s.supplier_configs(AlwaysBusy(),[(f'pokt{i}','eth') for i in range(200)],lambda _:None)
        self.assertEqual(calls,[200,100])

    def test_schema_errors_are_not_retried_or_hidden(self):
        calls=[]
        class WrongSchema:
            def gql(self,query,**v):
                calls.append(v);raise ValueError('GraphQL errors: Unknown field')
        with self.assertRaisesRegex(ValueError,'Unknown field'):
            s.supplier_configs(WrongSchema(),[('pokt1','eth')],lambda _:None)
        self.assertEqual(len(calls),1)

    def test_plans_keep_the_reviewed_dates_cutoff_and_service_set(self):
        self.assertEqual(s.plan()["services"],["eth"]);self.assertEqual(s.plan()["start"],"2026-09-29T00:00:00Z")
        self.assertEqual(s.plan("month")["services"],s.FIXED_SERVICES)
        self.assertEqual(s.plan("month")["start"],s.MONTH_START)

    def test_session_scope_is_not_restricted_to_sampled_applications(self):
        p=Pages([(older([row(1)]),None)]);self.download(p)
        self.assertEqual(p.before,[None])
        self.assertIn('services:$services',catalog.ROSTERS_QUERY)

    def test_settled_members_are_claims_and_idle_members_are_not(self):
        r=row();r.update(roster_size="2",member_ids=[SUPPLIER,"pokt1idle"],member_states=["paid","idle_others_worked"],
                        member_paid_upokt=["27","0"],member_owner_ids=[OWNER,OWNER])
        claims=s.session_claims(r,CONFIG,"eth")
        self.assertEqual([(c["supplierId"],c["payoutUpokt"]) for c in claims],[(SUPPLIER,"27")])
        zero=row(state="settled_zero",amount=0);self.assertEqual(s.session_claims(zero,CONFIG,"eth")[0]["payoutUpokt"],"0")
        for state in ("expired","discarded","slashed","idle_no_work"):
            self.assertEqual(s.session_claims(row(state=state),CONFIG,"eth"),[])

    def test_large_integer_amounts_are_exact(self):
        value=10**25+27;r=s.session_claims(row(amount=value),CONFIG,"eth")[0]
        self.assertEqual(int(r["payoutUpokt"]),value)

    def test_unindexed_money_stops_collection(self):
        missing=row();missing["money_missing"]=True
        with self.assertRaisesRegex(ValueError,"not indexed"):s.session_claims(missing,CONFIG,"eth")
        with self.assertRaisesRegex(ValueError,"not indexed"):s.session_claims(row(state="unresolved"),CONFIG,"eth")

    def test_sessions_settled_after_the_cutoff_or_not_yet_are_excluded(self):
        late=row();late["settled_height"]="955837"
        self.assertEqual(s.session_claims(late,CONFIG,"eth"),[])
        active=row();active.update(phase="proving",settled_height=None)
        self.assertEqual(s.session_claims(active,CONFIG,"eth"),[])

    def test_inconsistent_rosters_are_rejected(self):
        for field,value in [("service_id","base"),("roster_size","2"),("member_ids",[SUPPLIER,SUPPLIER])]:
            raw=row();raw[field]=value
            if field=="member_ids":raw.update(roster_size="2",member_states=["paid"]*2,member_paid_upokt=["1"]*2,member_owner_ids=[OWNER]*2)
            with self.assertRaises(ValueError):s.session_claims(raw,CONFIG,"eth")

    def test_window_is_applied_to_session_end_height(self):
        inside,before,after=row(1,start=939990),row(2,start=939970),row(3,start=952140)
        self.download(Pages([([after,inside,before],None)]))
        self.assertEqual([r[0] for r in self.db.execute("SELECT session FROM claims")],[inside["session_id"]])

    def test_pages_must_hold_every_settled_seat_the_catalog_totals(self):
        with self.assertRaisesRegex(ValueError,"network total disagree"):self.download(Pages([(older([row(1)]),None)],network=2))
        self.assertEqual(self.db.execute("SELECT status FROM services").fetchone()[0],"collecting")

    def test_resume_keeps_the_margin_and_seat_count_after_an_empty_last_page(self):
        first=[row(1,start=950901),row(2,start=950881),row(3,start=950861),row(10**6,start=939000,started="2026-09-28T23:30:00+00:00")]
        pages=[(first,1),([],None)]
        with self.assertRaisesRegex(RuntimeError,"429"):self.download(Pages(pages,fail=1))
        retry=Pages(pages);self.assertEqual(self.download(retry),3);self.assertEqual(len(retry.before),1)

    def test_catalog_margin_must_reach_before_the_window(self):
        with self.assertRaisesRegex(ValueError,"does not reach"):self.download(Pages([([row(1)],None)]))

    def test_settlement_gaps_and_short_coverage_are_rejected(self):
        for coverage in ({**RANGE,"gaps":[{"from":"2026-10-01T00:00:00Z","to":"2026-10-01T01:00:00Z"}]},
                         {**RANGE,"covered_to":"2026-10-06T00:00:00Z"},{**RANGE,"covered_from":"2026-09-29T00:00:00Z"}):
            with self.assertRaisesRegex(ValueError,"does not cover"):self.download(Pages([(older([row(1)]),None)],coverage=coverage))

    def test_unordered_pages_are_rejected(self):
        with self.assertRaisesRegex(ValueError,"unordered"):self.download(Pages([(older([row(1,start=950801),row(2,start=950901)]),None)]))

    def test_pages_and_resume_handle_every_page(self):
        first=[row(1,start=950901),row(2,start=950881),row(3,start=950861),row(4,start=950841)]
        p=Pages([(first,1),(older([row(5,start=950821)]),None)])
        self.assertEqual(self.download(p),5);s.verify_database(self.db)
        self.assertEqual(p.before,[None,f"950841:{row(4)['session_id']}"])
        again=Pages([]);self.assertEqual(self.download(again),5);self.assertEqual(again.before,[])

    def test_failure_resumes_from_the_committed_cursor(self):
        pages=[([row(1,start=950901),row(2,start=950881),row(3,start=950861),row(4,start=950841)],1),(older([row(5,start=950821)]),None)]
        with self.assertRaisesRegex(RuntimeError,"429"):self.download(Pages(pages,fail=1))
        self.assertEqual(self.db.execute("SELECT count(*) FROM claims").fetchone()[0],4)
        retry=Pages(pages);self.download(retry);self.assertEqual(retry.before,[f"950841:{row(4)['session_id']}"]);s.verify_database(self.db)

    def test_repeated_sessions_are_rejected_before_anything_is_stored(self):
        with self.assertRaisesRegex(ValueError,"unordered"):self.download(Pages([(older([row(1),row(1)]),None)]))
        pages=[([row(1,start=950901),row(2,start=950881),row(3,start=950861),row(4,start=950841)],1),(older([row(4,start=950841)]),None)]
        with self.assertRaisesRegex(ValueError,"unordered"):self.download(Pages(pages))
        self.assertEqual(self.db.execute("SELECT count(*) FROM claims").fetchone()[0],4)

    def test_duplicate_claims_rollback_the_entire_page(self):
        self.db.execute("INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?)",(f"{2:064x}:{SUPPLIER}","x","base","a",1,"x","{}",0,0));self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):self.download(Pages([(older([row(1),row(2,start=950881)]),None)]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM claims WHERE service='eth'").fetchone()[0],0)

    def test_modified_cached_claim_is_detected(self):
        self.download(Pages([(older([row()]),None)]))
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

    def recorded(self):
        fixture=json.loads(gzip.decompress((ROOT/'tests/fixtures/settlement-catalog-roster.json.gz').read_bytes()))
        calls=[]
        class Catalog:
            def gql(self,query,**v):
                calls.append((query,v))
                if query==catalog.PARAMS_QUERY:return {'getParamHistoryList':copy.deepcopy(fixture['params'])}
                if query==catalog.BLOCKS_QUERY:
                    ids=v['filter']['id']['in']
                    return {'blocks':{'totalCount':len(ids),'pageInfo':{'hasNextPage':False},'nodes':[{'id':h,'timestamp':fixture['blocks'][h]} for h in ids]}}
                return {'getSuppliersConfigHistoryJson':[r for r in copy.deepcopy(fixture['configs']) if r['supplier_id'] in v['ids'] and r['service_id'] in v['services']]}
        row=fixture['session']
        self.db.execute('INSERT INTO sessions VALUES(?,?,?)',(row['session_id'],'eth',json.dumps(row)));self.db.commit()
        return fixture,Catalog(),calls

    def test_live_recorded_catalog_roster_replays_without_network(self):
        fixture,client,calls=self.recorded()
        self.assertEqual(s.fetch_rosters(client,self.db,CONFIG,lambda _:None),1)
        roster=json.loads(self.db.execute('SELECT json FROM rosters').fetchone()[0])
        self.assertEqual(len(roster['members']),50);self.assertEqual(roster['selectionCap'],50)
        self.assertTrue(all(m['endpoints'] for m in roster['members']))
        self.assertEqual({q[1]['services'][0] for q in calls if q[0]==catalog.CONFIG_QUERY},{'eth'})
        original=next(r for r in REFERENCE['sessions'] if r['id']==roster['id'])
        self.assertEqual({m['id'] for m in roster['members']},{REFERENCE['supplierIds'][i] for i,_,_ in original['members']})

    def test_missing_member_config_stops_collection(self):
        fixture,client,_=self.recorded()
        fixture['configs'].clear()
        with self.assertRaisesRegex(ValueError,'lacks'):s.fetch_rosters(client,self.db,CONFIG,lambda _:None)

    def test_config_declared_before_the_session_start_is_the_one_served(self):
        # Recorded mainnet rows (2026-09): a restake inside session 913601..913620 and a config
        # that ended inside session 913141..913160; the archive roster showed the earlier config.
        restaked=[{'first_height':'901731','last_height':'913615','endpoints':[{'url':'https://igniter-nodefleet.relayminer.shannon-mainnet.eu.nodefleet.net','rpcType':'3'}]},
                  {'first_height':'913616','last_height':None,'endpoints':[{'url':'https://dopokt1.relayminer.shannon-mainnet.eu.nodefleet.net/','rpcType':'3'}]}]
        ended=[{'first_height':'874060','last_height':'913152','endpoints':[{'url':'https://eu-eth.sgtstake.com','rpcType':'3'}]}]
        configs={('a','eth'):restaked,('b','eth'):ended}
        self.assertEqual(s.config_at(configs,'a','eth',913601)[0]['url'],restaked[0]['endpoints'][0]['url'])
        self.assertEqual(s.config_at(configs,'a','eth',913621)[0]['url'],restaked[1]['endpoints'][0]['url'])
        self.assertEqual(s.config_at(configs,'b','eth',913141),[{'url':'https://eu-eth.sgtstake.com','rpc_type':'JSON_RPC'}])
        # A restake in the start block itself belongs to the next session.
        self.assertEqual(s.config_at(configs,'a','eth',913616)[0]['url'],restaked[0]['endpoints'][0]['url'])
        with self.assertRaisesRegex(ValueError,'lacks'):s.config_at(configs,'b','eth',913161)

    def test_compact_evidence_keeps_an_unknown_session_out_of_earnings(self):
        sid=f"{1:064x}"
        claim={'id':f'{sid}:{SUPPLIER}','supplierId':SUPPLIER,'serviceId':'eth','applicationId':'application','sessionId':sid,
               'sessionEndHeight':'950920','blockId':'951000','payoutUpokt':'27','payoutVerified':False,'block':{'timestamp':'2026-10-05T05:00:00Z'}}
        self.db.execute('INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?)',(claim['id'],sid,'eth','application',950920,SUPPLIER,json.dumps(claim),0,0))
        roster={'id':sid,'serviceId':'eth','applicationId':'application','endHeight':950920,'endedAt':'2026-10-05T03:00:00Z','selectedCount':1,
          'members':[{'id':SUPPLIER,'owner':OWNER,'endpoints':[]}]}
        self.db.execute('INSERT INTO rosters VALUES(?,?,?)',(roster['id'],json.dumps(roster),s.digest(roster)));self.db.commit()
        evidence=s.compact_evidence(self.db,CONFIG)
        self.assertEqual(evidence['sessions'][0]['payoutStatus'],'unknown')
        self.assertIsNone(evidence['sessions'][0]['poolUpokt']);self.assertEqual(evidence['sessions'][0]['payouts'],[])
        self.assertEqual(evidence['coverage']['unknownDistributionClaims'],1)

    def test_exact_original_payout_and_membership_overlap(self):
        original=copy.deepcopy(ORIGINAL);sid=original['id'];owners=REFERENCE['ownerIds'];ids=REFERENCE['supplierIds']
        r=row();r.update(session_id=sid,application_id=original['applicationId'],end_height=str(original['sessionEndHeight']),
                        roster_size=str(len(original['payouts'])),member_ids=[ids[i] for i,_ in original['payouts']],
                        member_states=['paid']*len(original['payouts']),member_paid_upokt=[v for _,v in original['payouts']],
                        member_owner_ids=[OWNER]*len(original['payouts']),settled_height=str(original['sessionEndHeight']+40))
        for pos,c in enumerate(s.session_claims(r,CONFIG,'eth')):
            c['block']={'timestamp':'2026-10-05T05:00:00Z'}
            self.db.execute('INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?)',(c['id'],sid,'eth',c['applicationId'],int(c['sessionEndHeight']),c['supplierId'],json.dumps(c),0,pos))
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
        with self.assertRaisesRegex(ValueError,'out of scope'):s.block_times(Blocks(),[950920,950940],{**CONFIG,'endExclusive':'2026-10-05T03:10:00Z'})
        self.assertEqual(len(s.block_times(Blocks(),[950920,950940],{**CONFIG,'endExclusive':'2026-10-05T03:10:00Z'},window=False)),2)
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
