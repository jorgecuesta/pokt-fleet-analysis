import io
import json
import math
import sys
import unittest
from pathlib import Path
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/"analysis"))
import monthly_analysis as analysis


class MonthlyEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data, cls.sha = analysis.load_snapshot(ROOT/"data/live-snapshot.json.gz")
        cls.report = analysis.analyse(cls.data, cls.sha)

    def test_uploaded_month_is_structurally_complete(self):
        self.assertEqual(analysis.validate_snapshot(self.data)["unknown"], 2428)

    def test_wrong_payload_is_rejected_before_analysis(self):
        with self.assertRaisesRegex(ValueError, "checksum"):
            analysis.load_snapshot(ROOT/"data/live-snapshot.json.gz", "incorrect")

    def test_absent_claims_stay_in_the_denominator(self):
        r = self.report
        self.assertEqual(r["overall"]["sessions"], 4080)
        self.assertEqual(r["overall"]["covered"], 1652)
        self.assertEqual(r["neverCoveredGroupCount"], 19)
        self.assertEqual(r["unknownInNeverCoveredGroups"], 2280)
        self.assertEqual(r["overall"]["unverifiedClaims"], 0)

    def test_time_partitions_reconcile(self):
        for key in ["daily", "hourly", "perService", "applicationGroups"]:
            self.assertEqual(sum(r["sessions"] for r in self.report[key]), 4080)
            self.assertEqual(sum(r["covered"] for r in self.report[key]), 1652)

    def test_python_reconciliation_matches_the_existing_product_engine(self):
        cases = json.loads((ROOT/"analysis/engine-reconciliation.json").read_text())["cases"]
        for case in cases:
            with self.subTest(scope=case["scope"], days=case["days"], service=case["serviceIds"]):
                result = analysis.covered_fleet_result(self.data, case["scope"], case["serviceIds"], case["days"])
                for key, expected in case["expected"].items():
                    if expected is None:
                        self.assertIsNone(result[key])
                    else:
                        self.assertTrue(math.isclose(result[key], expected, rel_tol=1e-9, abs_tol=1e-6), key)

    def test_unknown_amount_is_not_equal_to_verified_zero(self):
        session = self.data["sessions"][0]
        unknown = dict(session, payoutStatus="missing", settledClaimCount=0)
        verified_zero = dict(session, payoutStatus="complete", totalPayoutPokt=0, supplierPayouts=[])
        r = analysis.coverage_row([unknown, verified_zero])
        self.assertEqual((r["covered"], r["unknown"], r["noIndexedClaims"]), (1, 1, 1))

    def test_invalid_endpoint_remains_visible(self):
        self.assertEqual(len(self.report["invalidEndpoints"]), 1)
        self.assertEqual(self.report["invalidEndpoints"][0]["serviceId"], "arb-one")


class DiagnosticTests(unittest.TestCase):
    @staticmethod
    def response(data):
        return io.BytesIO(json.dumps(data).encode())

    def test_graphql_errors_are_not_successful_http_data(self):
        with self.assertRaisesRegex(analysis.ProbeError, "GraphQL errors"):
            analysis.graphql_request("query{}", transport=lambda *a, **k: self.response({"errors": [{"message": "rejected"}]}))

    def test_rate_limit_preserves_status_and_retry_after(self):
        def limited(*a, **k):
            raise HTTPError("https://data.pocket.network/graphql", 429, "rate limit", {"Retry-After": "60"}, None)
        with self.assertRaisesRegex(analysis.ProbeError, "HTTP 429; Retry-After: 60"):
            analysis.graphql_request("query{}", transport=limited)

    def test_transport_failure_is_distinguished_from_rate_limit(self):
        def unavailable(*a, **k):
            raise URLError("connection refused")
        with self.assertRaisesRegex(analysis.ProbeError, "not evidence of an HTTP rate limit"):
            analysis.graphql_request("query{}", transport=unavailable)

    def test_history_check_is_bounded_and_pinned_without_rewriting_evidence(self):
        calls = []
        report = {"cutoff": 955836, "applicationGroups": [{"serviceId": "eth", "applicationId": "test-app", "covered": 0}]}
        def transport(request, **kwargs):
            body = json.loads(request.data)
            calls.append(body)
            if len(calls) == 1:
                return self.response({"data": {"_metadata": {"chain": "pocket", "lastProcessedHeight": 955900},
                       "blocks": {"nodes": [{"id": "955836", "timestamp": "2026-10-08T13:31:00"}]}}})
            return self.response({"data": {"getNetworkSessionsJson": {"range": {"covered_from": "2026-08-26T03:47:54Z", "gaps": []}, "data": []}}})
        before = json.dumps(report)
        result = analysis.verify_indexed_history(report, 1, transport)
        self.assertEqual(len(calls), 2)
        self.assertIn('equalTo:"955836"', calls[0]["query"])
        self.assertEqual(calls[1]["variables"], {"b": "2026-10-08T13:31:00Z", "apps": ["test-app"], "services": ["eth"]})
        self.assertEqual(result["results"][0]["indexedHistoryCountThroughCutoff"], 0)
        self.assertEqual(result["results"][0]["historyCoveredFrom"], "2026-08-26T03:47:54Z")
        self.assertIn("Not a monthly total", result["results"][0]["interpretation"])
        self.assertEqual(json.dumps(report), before)

    def test_settlements_after_the_cutoff_are_removed_and_an_unindexed_cutoff_stops(self):
        report = {"cutoff": 955836, "applicationGroups": [{"serviceId": "eth", "applicationId": "test-app", "covered": 0}]}
        head = {"data": {"_metadata": {"chain": "pocket", "lastProcessedHeight": 955900},
                         "blocks": {"nodes": [{"id": "955836", "timestamp": "2026-10-08T13:31:00"}]}}}
        late = {"data": {"getNetworkSessionsJson": {"range": {"covered_from": "2026-08-26T03:47:54Z", "gaps": []},
                "data": [{"application_id": "test-app", "service_id": "eth", "paid": "1", "settled_zero": "0", "last_height": "955840"}]}}}
        settled_late = {"data": {"getSessionRostersJson": {"range": {"gaps": []}, "data": [
            {"settled_height": "955840", "member_states": ["paid", "idle_others_worked"]},
            {"settled_height": "955830", "member_states": ["paid"]}]}}}
        answers = iter([head, late, settled_late])
        result = analysis.verify_indexed_history(report, 1, lambda *a, **k: self.response(next(answers)))
        self.assertEqual((result["results"][0]["indexedHistoryCountThroughCutoff"], result["requestCount"]), (0, 3))
        too_many = {"data": {"getSessionRostersJson": {"range": {"gaps": []}, "data": [
            {"settled_height": "955840", "member_states": ["paid", "paid"]}]}}}
        answers = iter([head, late, too_many])
        with self.assertRaisesRegex(analysis.ProbeError, "exceeds the history count"):
            analysis.verify_indexed_history(report, 1, lambda *a, **k: self.response(next(answers)))
        missing = {"data": {"_metadata": {"chain": "pocket", "lastProcessedHeight": 955900}, "blocks": {"nodes": []}}}
        with self.assertRaisesRegex(analysis.ProbeError, "cutoff block is not indexed"):
            analysis.verify_indexed_history(report, 1, lambda *a, **k: self.response(missing))

    def test_behind_indexer_stops_before_claim_queries(self):
        def transport(*a, **k):
            return self.response({"data": {"_metadata": {"lastProcessedHeight": 955800}, "blocks": {"nodes": []}}})
        with self.assertRaisesRegex(analysis.ProbeError, "behind the saved cutoff"):
            analysis.verify_indexed_history({"cutoff": 955836, "applicationGroups": []}, transport=transport)


if __name__ == "__main__":
    unittest.main()
