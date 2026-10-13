"""Offline checks against recorded protocol evidence and missing-outcome cases."""
import copy
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "collector"))
import pokt_live_collector as c


class CollectorTests(unittest.TestCase):
    def test_endpoint_parsing_uses_suffix_rules_and_preserves_transport_structure(self):
        e=c.parse_endpoint({"url":"https://BASE.Relay.Example.CO.UK.:8443/v1/rpc", "rpc_type":"JSON_RPC"}, "recorded-service")
        self.assertEqual(e["serviceId"],"recorded-service")
        self.assertEqual(e["hostname"],"base.relay.example.co.uk")
        self.assertEqual(e["registrableDomain"],"example.co.uk")
        self.assertEqual(e["publicSuffix"],"co.uk")
        self.assertEqual(e["subdomainLabels"],["base","relay"])
        self.assertEqual(e["port"],8443)
        self.assertEqual(e["pathSegments"],["v1","rpc"])
        cases={"a.b.ck":("a.b.ck","b.ck"),"a.www.ck":("www.ck","ck"),
               "rpc.tenant.github.io":("tenant.github.io","github.io"),
               "rpc.city.kawasaki.jp":("city.kawasaki.jp","kawasaki.jp")}
        for host,(domain,suffix) in cases.items():
            with self.subTest(host=host):
                parts=c.domain_parts(host)
                self.assertEqual(parts["registrableDomain"],domain)
                self.assertEqual(parts["publicSuffix"],suffix)
        self.assertEqual(c.parse_endpoint({"url":"https://münchen.de"},"svc")["hostname"],"xn--mnchen-3ya.de")
        ip=c.parse_endpoint({"url":"http://[2001:db8::1]:8080/rpc"},"svc")
        self.assertEqual(ip["hostKind"],"ip")
        self.assertIsNone(ip["registrableDomain"])
        self.assertEqual(ip["port"],8080)
        self.assertEqual(c.parse_endpoint({"url":"wss://rpc.example.org/ws"},"svc")["scheme"],"wss")

    def test_public_endpoint_fields_redact_values_and_invalid_urls_remain_visible(self):
        raw="https://user:secret@rpc.example.com/v1?token=secret-value&network=mainnet#private-fragment"
        e=c.parse_endpoint({"url":raw},"svc")
        self.assertEqual(e["url"],"https://rpc.example.com/v1")
        self.assertEqual(e["queryKeys"],["network","token"])
        self.assertEqual(e["redactedParts"],["userinfo","query_values","fragment"])
        self.assertNotIn("secret",json.dumps(e))
        for url in ("https://rpc.example.com:99999","javascript:alert(1)","https://bad host.example/","https://rpc.example.com/\nrpc"):
            with self.subTest(url=url):
                e=c.parse_endpoint({"url":url},"svc")
                self.assertEqual(e["parseStatus"],"invalid")
                self.assertTrue(e["sourceUrlSha256"])
        self.assertIsNone(c.domain_parts("co.uk")["registrableDomain"])

    def test_pocket_accounts_are_validated_without_inventing_operator_attributes(self):
        data=c.read_json(ROOT/"data/live-snapshot.json.gz")
        address=data["suppliers"][0]["id"]
        parts=c.address_parts(address)
        self.assertEqual(parts["prefix"],"pokt")
        self.assertTrue(parts["checksumValid"])
        self.assertEqual(parts["payloadBytes"],20)
        self.assertEqual(len(parts["payloadHex"]),40)
        with self.assertRaisesRegex(ValueError,"checksum"):
            c.address_parts(address[:-1]+("q" if address[-1]!="q" else "p"))
        with self.assertRaises(ValueError):
            c.address_parts(address[:5].upper()+address[5:])
        self.assertNotIn("operator",parts)

    def test_legacy_point_endpoint_recovery_uses_its_original_height(self):
        data=c.read_json(ROOT/"data/live-snapshot.json.gz")
        supplier=data["suppliers"][0]
        owner=supplier["ownerHistory"][0]["ownerId"]
        point={"point":{"height":123,"observedAt":"2026-10-05T03:00:00Z"},
               "registry":[{"id":supplier["id"],"owner":owner,"services":["svc"],"hosts":["rpc.example.com"]}]}
        raw={"operator_address":supplier["id"],"owner_address":owner,"services":[{"service_id":"svc","endpoints":[{"url":"https://rpc.example.com/rpc"}]}]}
        with tempfile.TemporaryDirectory() as folder:
            client=c.Client(folder)
            with patch.object(client,"pages",return_value=[raw]) as pages:
                upgraded=c.upgrade_point_registry(copy.deepcopy(point),client,["svc"])
                self.assertEqual(pages.call_args.args[2],123)
                self.assertEqual(upgraded["registry"][0]["endpoints"][0]["path"],"/rpc")
                self.assertEqual(upgraded["registrySchemaVersion"],2)
            from export_cached_snapshot import OfflineClient
            offline=OfflineClient(folder)
            with patch("urllib.request.urlopen",side_effect=AssertionError("No network")):
                with self.assertRaisesRegex(ValueError,"no network requests"):
                    offline.request("https://example.invalid/registry",height=123)

    def test_fixed_eight_and_monthly_runner_dry_run_are_explicit_and_offline(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(c,"discover",return_value={"cutoff":123}) as discover, patch.object(c,"collect") as collect, patch.object(sys,"argv",["collector","collect","--out",folder,"--fixed-eight"]):
                c.main()
                self.assertEqual(collect.call_args.args[2],30)
                self.assertEqual(set(collect.call_args.args[3]),set(c.FIXED_SERVICES))
            import run_month
            with patch.object(run_month,"discover",side_effect=AssertionError("No network")),patch.object(run_month,"collect",side_effect=AssertionError("No collection")),patch.object(sys,"argv",["runner","--dry-run","--out",folder]):
                run_month.main()

    def test_monthly_resume_preserves_legacy_catalogue_and_rejects_changed_cutoffs(self):
        import run_month
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);run=root/'runs'/'recorded';run.mkdir(parents=True)
            end='2026-10-06T00:00:00Z'
            c.atomic_json(run/'run.json',{'config':{'cutoff':50,'endExclusive':end}})
            c.atomic_json(root/'catalog.json',{'cutoff':50,'endExclusive':end})
            self.assertEqual(run_month.resume_catalogue(run/'run.json',root)['cutoff'],50)
            c.atomic_json(root/'catalog.json',{'cutoff':200,'endExclusive':end})
            with self.assertRaisesRegex(ValueError,'original fixed cutoff'):
                run_month.resume_catalogue(run/'run.json',root)
            c.atomic_json(run/'catalog.json',{'cutoff':50,'endExclusive':end})
            self.assertEqual(run_month.resume_catalogue(run/'run.json',root)['cutoff'],50)
            c.atomic_json(run/'catalog.json',{'cutoff':50,'endExclusive':'2026-10-07T00:00:00Z'})
            with self.assertRaisesRegex(ValueError,'end date'):
                run_month.resume_catalogue(run/'run.json',root)

    def test_monthly_frame_rejects_missing_duplicate_points_and_preserves_existing_product(self):
        import run_month
        from datetime import timedelta
        start=c.dt('2026-09-06T00:00:00Z')
        snapshot={'dataKind':'live','period':{'start':c.iso(start),'endExclusive':c.iso(start+timedelta(days=30))},
                  'services':[{'id':s} for s in c.FIXED_SERVICES], 'suppliers':[], 'sessions':[],
                  'populations':[{'serviceId':s,'scheduledAt':c.iso(start+timedelta(days=d,hours=h))}
                                 for s in c.FIXED_SERVICES for d in range(30) for h in c.HOURS],
                  'liveSource':{'cutoff':50,'coverage':{'samplePoints':120},'endpointParsing':{}}}
        audit=run_month.validate_month(snapshot)
        self.assertEqual(audit['serviceObservations'],960)
        self.assertEqual(len(audit['perServicePayoutEvidence']),8)
        missing=copy.deepcopy(snapshot);missing['populations'].pop()
        duplicate=copy.deepcopy(snapshot);duplicate['populations'][-1]=duplicate['populations'][0]
        for bad in (missing,duplicate):
            with self.assertRaisesRegex(ValueError,'Missing or duplicated'):
                run_month.validate_month(bad)
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'current.json.gz';original=b'previous published evidence';output.write_bytes(original)
            with patch.object(run_month,'discover',return_value={}),patch.object(run_month,'collect',return_value=missing),patch.object(sys,'argv',['runner','--out',str(Path(folder)/'cache'),'--product-output',str(output)]):
                with self.assertRaisesRegex(ValueError,'Missing or duplicated'):
                    run_month.main()
            self.assertEqual(output.read_bytes(),original)
    def test_protocol_matches_recorded_rest_rosters(self):
        vectors = c.read_json(ROOT / "tests/fixtures/session-reconciliation.json.gz")
        self.assertEqual(vectors["protocolCommit"], c.SUPPORTED_PROTOCOL_COMMIT)
        for v in vectors["vectors"]:
            with self.subTest(service=v["serviceId"]):
                result = c.reconstructed_session(v["applicationId"], v["serviceId"], v["sampleHeight"], v["sharedParams"], v["blockHash"], v["eligible"], v["cap"])
                self.assertTrue(v["restReconciled"])
                self.assertEqual(result["header"]["session_id"], v["expectedId"])
                self.assertEqual([s["operator_address"] for s in result["suppliers"]], v["expectedSuppliers"])

    def test_application_activation_transfer_and_unstake_boundaries(self):
        app = {"service_config_history": [{"service": {"service_id": "old"}, "activation_height": 1, "deactivation_height": 100}, {"service": {"service_id": "new"}, "activation_height": 100, "deactivation_height": 0}]}
        self.assertEqual(c.application_services(app, 99, 100), ["old"])
        self.assertEqual(c.application_services(app, 100, 120), ["new"])
        app["unstake_session_end_height"] = 120
        self.assertEqual(c.application_services(app, 100, 120), ["new"])
        self.assertEqual(c.application_services(app, 100, 140), [])
        app.pop("unstake_session_end_height")
        app["pending_transfer"] = {"session_end_height": 120}
        self.assertEqual(c.application_services(app, 100, 120), ["new"])
        self.assertEqual(c.application_services(app, 100, 140), [])

    def test_streamed_assembly_preserves_dated_ownership_and_unknown_payouts(self):
        catalog = {"selectedServices": ["svc"], "services": [{"id": "svc", "name": "Example"}], "activityShare": .8, "fetchedAt": "2026-10-08T00:00:00Z", "activityWindow": {"start": "2026-09-29T00:00:00Z", "endExclusive": "2026-10-06T00:00:00Z"}, "targetShare": .95, "maxServices": 8, "selectionRule": "indexed compute"}
        config = {"services": ["svc"], "start": "2026-10-05T00:00:00Z", "endExclusive": "2026-10-06T00:00:00Z", "hours": [3,9], "cutoff": 999}
        parts = []
        for i, hour in enumerate((3,9,15)):
            at = f"2026-10-05T{hour:02}:00:00Z"
            pop = {"id": f"p{i}", "serviceId": "svc", "observedAt": at, "height": i+1, "totalEligible": 1, "selectionCap": 50, "eligibleSupplierIds": ["supplier"]}
            session = {"id": f"s{i}", "serviceId": "svc", "applicationId": "app", "populationId": pop["id"], "startedAt": at, "selectedSupplierIds": ["supplier"], "selectedCount": 1}
            parts.append({"point": {"observedAt": at, "height": i+1}, "populations": [pop], "sessions": [session], "registry": [{"id": "supplier", "owner": "owner-a" if i==0 else "owner-b", "services": ["svc"], "hosts": ["a.example" if i==0 else "b.example"]}]})
        claims = [{"sessionId": "s0", "supplierId": "supplier", "applicationId": "app", "payoutVerified": True, "payoutUpokt": "2000000", "numEstimatedRelays": "10", "block": {"timestamp": "2026-10-06T00:00:00Z"}}, {"sessionId": "s1", "supplierId": "supplier", "applicationId": "app", "payoutVerified": False, "payoutUpokt": "0", "numEstimatedRelays": "10", "block": {"timestamp": "2026-10-06T00:00:00Z"}}]
        with tempfile.TemporaryDirectory() as folder:
            paths = []
            for i, part in enumerate(parts):
                path = Path(folder) / f"{i+1}.json.gz"
                c.atomic_json(path, part)
                paths.append(path)
            result = c.assemble(paths, claims, catalog, config, {})
        supplier = result["suppliers"][0]
        self.assertEqual(supplier["ownerHistory"][0]["end"], "2026-10-05T09:00:00Z")
        self.assertEqual(supplier["endpointHistory"][1]["hosts"], ["b.example"])
        self.assertEqual(result["sessions"][0]["totalPayoutPokt"], 2)
        for session in result["sessions"][1:]:
            self.assertEqual(session["payoutStatus"], "missing")
            self.assertIsNone(session["totalPayoutPokt"])
            self.assertEqual(session["supplierPayouts"], [])
        self.assertTrue(all(row["availability"] != "available" for row in result["liveSource"]["leaderboards"]["30"]["svc"]))
        with self.assertRaisesRegex(ValueError, "Duplicate settled claim"):
            c.assemble(copy.deepcopy(parts), claims+[claims[0]], catalog, config, {})

    def test_corrupt_cache_and_duplicate_pages_fail_before_publication(self):
        with tempfile.TemporaryDirectory() as folder:
            client = c.Client(folder)
            url = "https://example.invalid/record"
            key = c.digest([c.CACHE_NAMESPACE, url, None, None, None])
            path = Path(folder) / "responses" / key[:2] / (key+".json.gz")
            c.atomic_json(path, {"response": {"tampered": True}, "response_sha256": c.digest({"tampered": False})})
            with patch("urllib.request.urlopen", side_effect=AssertionError("No network in offline tests")):
                with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                    client.request(url)
            client.rest = lambda *args, **kwargs: {"supplier": [{"operator_address": "same"}], "pagination": {"next_key": "cursor"}}
            with self.assertRaisesRegex(ValueError, "Duplicate or missing REST registry identity"):
                client.pages("/ignored", "supplier")

    def test_new_collections_refresh_but_resumes_keep_the_frozen_catalogue(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            saved={"cutoff":100,"selectedServices":["svc"]}
            c.atomic_json(root/'catalog.json',saved)
            with patch.object(c,'discover',return_value={**saved,'cutoff':200}) as discover, patch.object(c,'collect') as collect, patch.object(sys,'argv',['collector','collect','--out',folder]):
                c.main()
                discover.assert_called_once()
                self.assertEqual(collect.call_args.args[1]['cutoff'],200)
            with patch.object(c,'discover') as discover, patch.object(c,'collect') as collect, patch.object(sys,'argv',['collector','collect','--out',folder,'--reuse-catalog']):
                c.main()
                discover.assert_not_called()
                self.assertEqual(collect.call_args.args[1]['cutoff'],100)
            run=root/'runs'/'recorded'
            run.mkdir(parents=True)
            c.atomic_json(run/'run.json',{'config':{'cutoff':50}})
            c.atomic_json(run/'catalog.json',{**saved,'cutoff':50})
            with patch.object(c,'discover') as discover, patch.object(c,'collect') as collect, patch.object(sys,'argv',['collector','collect','--out',folder,'--resume',str(run/'run.json')]):
                c.main()
                discover.assert_not_called()
                self.assertEqual(collect.call_args.args[1]['cutoff'],50)

    def test_unsupported_protocol_leaves_a_failed_run_and_no_published_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            client=c.Client(folder)
            client.rest=lambda *a,**k:{'application_version':{'version':'unknown','git_commit':'unknown'}}
            catalog={'endExclusive':'2026-10-06T00:00:00Z','selectedServices':['svc'],'services':[{'id':'svc'}],'cutoff':999}
            point={'height':888888,'observedAt':'2026-10-05T03:00:00Z'}
            with patch.object(c,'resolve_schedule',return_value=[point]):
                with self.assertRaisesRegex(ValueError,'Unsupported deployed protocol'):
                    c.collect(client,catalog,days=1,roster_mode='rest')
            runs=list((Path(folder)/'runs').iterdir())
            self.assertEqual(len(runs),1)
            self.assertEqual(c.read_json(runs[0]/'run.json')['status'],'failed')
            self.assertFalse((runs[0]/'snapshot.json.gz').exists())
            self.assertFalse((Path(folder)/'latest.json').exists())


if __name__ == "__main__":
    unittest.main()
