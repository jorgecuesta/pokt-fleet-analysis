"""Read-only analysis of the fleet analyser's saved monthly product.

No collection or payout policy is changed. Optional indexed-history probes are
bounded diagnostics and never turn an absent claim into a verified zero.
"""
import csv
import gzip
import hashlib
import json
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

EXPECTED_SHA256 = "feeebfbb120044a782dd60f1879c0613924cb259b7eb528d5f74659055842088"
SERVICES = ["arb-one", "base", "bsc", "eth", "opbnb", "poly", "robinhood", "solana"]
GRAPHQL = "https://data.pocket.network/graphql"


def date(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_snapshot(path, expected_sha256=EXPECTED_SHA256):
    raw = Path(path).read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    if expected_sha256 and sha != expected_sha256:
        raise ValueError("Snapshot checksum differs. Select the intended file explicitly; do not mix collection runs.")
    return json.loads(gzip.decompress(raw)), sha


def validate_snapshot(data, monthly=True):
    """Check the saved evidence itself, independently of the uploaded audit."""
    def require(ok, message):
        if not ok:
            raise ValueError(message)

    require(data["dataKind"] == "live", "Expected live evidence")
    start, end = date(data["period"]["start"]), date(data["period"]["endExclusive"])
    if monthly:
        require(end - start == timedelta(days=30), "Expected exactly 30 UTC days")
        require(set(s["id"] for s in data["services"]) == set(SERVICES), "Wrong monthly service set")
        expected = {(sid, (start + timedelta(days=d, hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ"))
                    for sid in SERVICES for d in range(30) for h in (3, 9, 15, 21)}
        actual = [(p["serviceId"], p["scheduledAt"]) for p in data["populations"]]
        require(len(actual) == len(expected) and set(actual) == expected, "Incomplete or duplicate monthly observation frame")
    suppliers = {s["id"]: s for s in data["suppliers"]}
    require(len(suppliers) == len(data["suppliers"]), "Duplicate Supplier identity")
    ids = list(suppliers)
    endpoints = {e["id"]: e for e in data["endpointCatalog"]}
    require(len(endpoints) == len(data["endpointCatalog"]), "Duplicate endpoint identity")
    populations = {}
    for p in data["populations"]:
        require(p["id"] not in populations, "Duplicate population identity")
        if "eligibleSupplierIndices" in p:
            indices = p["eligibleSupplierIndices"]
            require(all(isinstance(i, int) and 0 <= i < len(ids) for i in indices), "Invalid compact Supplier index")
            eligible = [ids[i] for i in indices]
        else:
            eligible = p["eligibleSupplierIds"]
        require(len(eligible) == p["totalEligible"] == len(set(eligible)), "Population count mismatch")
        require(set(eligible) <= suppliers.keys(), "Unknown eligible Supplier")
        populations[p["id"]] = (p, set(eligible))
    for s in suppliers.values():
        for h in s["ownerHistory"] + s["endpointHistory"]:
            require(h.get("end") is None or date(h["start"]) < date(h["end"]), "Invalid historical interval")
        for h in s["endpointHistory"]:
            require(set(h["endpointIds"]) <= endpoints.keys(), "Broken historical endpoint association")
    seen = set()
    covered = 0
    for s in data["sessions"]:
        require(s["id"] not in seen, "Duplicate session")
        seen.add(s["id"])
        require(start <= date(s["startedAt"]) < end, "Session outside snapshot window")
        p, eligible = populations[s["populationId"]]
        require(p["serviceId"] == s["serviceId"], "Session/population service mismatch")
        selected = s["selectedSupplierIds"]
        require(s["rosterStatus"] == "complete", "Incomplete session roster")
        require(len(selected) == len(set(selected)) == s["selectedCount"] == min(p["selectionCap"], p["totalEligible"]), "Roster size mismatch")
        require(set(selected) <= eligible, "Selected Supplier was not historically eligible")
        if s["payoutStatus"] == "complete":
            covered += 1
            payouts = s["supplierPayouts"]
            require(set(x["supplierId"] for x in payouts) <= set(selected), "Payout recipient outside session roster")
            require(all(math.isfinite(x["pokt"]) and x["pokt"] >= 0 for x in payouts), "Invalid payout amount")
            require(math.isclose(sum(x["pokt"] for x in payouts), s["totalPayoutPokt"], rel_tol=1e-9, abs_tol=1e-6), "Payout amounts do not reconcile")
        else:
            require(s["totalPayoutPokt"] is None and s["supplierPayouts"] == [], "Unknown payout was converted to an amount")
    c = data["liveSource"]["coverage"]
    require(c["sessions"] == len(seen) and c["comparableSessions"] == covered, "Coverage metadata mismatch")
    require(c["settledClaims"] == sum(s["settledClaimCount"] for s in data["sessions"]), "Claim-count metadata mismatch")
    return {"status": "passed", "sessions": len(seen), "covered": covered,
            "unknown": len(seen) - covered, "populations": len(populations), "suppliers": len(suppliers)}


def coverage_row(sessions):
    n = len(sessions)
    covered = sum(s["payoutStatus"] == "complete" and s["rosterStatus"] == "complete" and s["selectedCount"] > 0 for s in sessions)
    unknown = [s for s in sessions if s["payoutStatus"] != "complete"]
    return {"sessions": n, "covered": covered, "unknown": n-covered,
            "coverage": covered/n if n else None,
            "noIndexedClaims": sum(s.get("settledClaimCount", 0) == 0 for s in unknown),
            "unverifiedClaims": sum(s.get("settledClaimCount", 0) > 0 for s in unknown),
            "indexedClaims": sum(s.get("settledClaimCount", 0) for s in sessions)}


def analyse(data, sha256=None):
    sessions = data["sessions"]
    groups = defaultdict(list)
    daily = defaultdict(list)
    hourly = defaultdict(list)
    for s in sessions:
        groups[(s["serviceId"], s["applicationId"])].append(s)
        daily[(s["scheduledAt"][:10], s["serviceId"])].append(s)
        hourly[(s["serviceId"], s["scheduledAt"][11:13])].append(s)
    applications = [{"serviceId": sid, "applicationId": app, **coverage_row(rows)} for (sid, app), rows in sorted(groups.items())]
    never = [row for row in applications if row["covered"] == 0]
    per_service = [{"serviceId": service["id"], **coverage_row([s for s in sessions if s["serviceId"] == service["id"]]),
                    "applicationGroups": sum(r["serviceId"] == service["id"] for r in applications),
                    "neverCoveredGroups": sum(r["serviceId"] == service["id"] for r in never)} for service in data["services"]]
    overall = coverage_row(sessions)
    return {"snapshotId": data["snapshotId"], "productSha256": sha256, "period": data["period"],
            "cutoff": data["liveSource"]["cutoff"], "overall": overall,
            "applicationGroups": applications, "perService": per_service,
            "daily": [{"date": day, "serviceId": sid, **coverage_row(rows)} for (day, sid), rows in sorted(daily.items())],
            "hourly": [{"serviceId": sid, "hourUTC": hour, **coverage_row(rows)} for (sid, hour), rows in sorted(hourly.items())],
            "neverCoveredGroupCount": len(never), "unknownInNeverCoveredGroups": sum(r["unknown"] for r in never),
            "invalidEndpoints": [e for e in data["endpointCatalog"] if e["parseStatus"] != "parsed"],
            "ownerChanges": sum(len(s["ownerHistory"]) > 1 for s in data["suppliers"]),
            "endpointChanges": sum(len(s["endpointHistory"]) > 1 for s in data["suppliers"]),
            "interpretation": "No indexed claim is not verified zero income. All sessions stay in coverage denominators. F describes covered sampled sessions only."}


def covered_fleet_result(data, scope, service_ids=None, days=30):
    """Same session-weighted numerator/denominator as src/engine.js.

    This is a reconciliation, not a second ranking or bootstrap implementation.
    Owner/domain membership follows the recorded service-specific history.
    """
    end = date(data["period"]["endExclusive"])
    start = max(date(data["period"]["start"]), end-timedelta(days=days))
    suppliers = {s["id"]: s for s in data["suppliers"]}
    endpoints = {e["id"]: e for e in data["endpointCatalog"]}

    def matches(supplier_id, at, service):
        supplier = suppliers[supplier_id]
        if scope["type"] == "network":
            return True
        if scope["type"] == "owner":
            return any(h["ownerId"] == scope["value"] and date(h["start"]) <= at and (h["end"] is None or at < date(h["end"])) for h in supplier["ownerHistory"])
        if scope["type"] == "domain":
            return any(date(h["start"]) <= at and (h["end"] is None or at < date(h["end"])) and
                       any(endpoints[i]["serviceId"] == service and endpoints[i].get("registrableDomain") == scope["value"] for i in h["endpointIds"])
                       for h in supplier["endpointHistory"])
        raise ValueError("Reconciliation supports network, owner or registrable domain scopes")

    rows = [s for s in data["sessions"] if start <= date(s["startedAt"]) < end and (service_ids is None or s["serviceId"] in service_ids)]
    actual = reference = 0.0
    covered = 0
    daily = defaultdict(lambda: {"actualPokt": 0.0, "equalSharePokt": 0.0, "sessions": 0})
    for s in rows:
        if not (s["payoutStatus"] == s["rosterStatus"] == "complete" and s["selectedCount"] > 0):
            continue
        at = date(s["startedAt"])
        own = {i for i in s["selectedSupplierIds"] if matches(i, at, s["serviceId"])}
        a = sum(p["pokt"] for p in s["supplierPayouts"] if p["supplierId"] in own)
        r = s["totalPayoutPokt"]*len(own)/s["selectedCount"]
        actual += a
        reference += r
        covered += 1
        day = daily[s["startedAt"][:10]]
        day["actualPokt"] += a
        day["equalSharePokt"] += r
        day["sessions"] += 1
    ratio = actual/reference if reference > 0 else None
    return {"actualPokt": actual if covered else None, "equalSharePokt": reference if covered else None,
            "ratio": ratio, "differencePercent": (ratio-1)*100 if ratio is not None else None,
            "covered": covered, "sessions": len(rows), "coverage": covered/len(rows) if rows else None,
            "daily": [{"date": day, **r} for day, r in sorted(daily.items())]}


def write_outputs(report, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output/"monthly-analysis.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    for key, name in [("perService", "service-coverage.csv"), ("applicationGroups", "application-coverage.csv"), ("daily", "daily-coverage.csv"), ("hourly", "hourly-coverage.csv")]:
        rows = report[key]
        with (output/name).open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    return output


class ProbeError(RuntimeError):
    pass


def graphql_request(query, variables=None, transport=None):
    """One POST, no retry storm, no credentials; preserve actionable failure type."""
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    request = Request(GRAPHQL, data=body, headers={"Content-Type": "application/json", "User-Agent": "POKT-fleet-analysis-review/1.0"})
    try:
        with (transport or urlopen)(request, timeout=45) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ProbeError("Response exceeds the 2 MB diagnostic limit")
        result = json.loads(raw)
    except HTTPError as e:
        raise ProbeError(f"HTTP {e.code}; Retry-After: {e.headers.get('Retry-After', 'not supplied')}. Stop and save this output.") from e
    except (URLError, TimeoutError, OSError) as e:
        raise ProbeError(f"Connection/timeout failure: {e}. This is not evidence of an HTTP rate limit.") from e
    except (ValueError, UnicodeError) as e:
        raise ProbeError("Response is not valid GraphQL JSON") from e
    if result.get("errors"):
        raise ProbeError("GraphQL errors: "+json.dumps(result["errors"])[:1500])
    if not isinstance(result.get("data"), dict):
        raise ProbeError("Missing GraphQL data object")
    return result["data"]


LATE_QUERY = ('query($a:Datetime,$b:Datetime,$apps:[String],$services:[String]){getSessionRostersJson('
              'rangeStart:$a,rangeEnd:$b,applications:$apps,services:$services,rowLimit:1000)}')


def iso(value):
    # Indexer block timestamps omit the UTC suffix.
    value = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def verify_indexed_history(report, max_groups=4, transport=None):
    """Bounded check: any indexed settled claims through the original cutoff?

    Counts come from the pocketdex session catalog: getNetworkSessionsJson over every
    session that started before the cutoff block, as far back as the catalog's
    rosters reach (covered_from). A historical result may be outside this month's
    window. It cannot settle missing sampled outcomes, establish full traffic or
    prove true inactivity.
    """
    if not isinstance(max_groups, int) or not 1 <= max_groups <= 19:
        raise ValueError("max_groups must be between 1 and 19")
    cutoff = int(report["cutoff"])
    head = graphql_request('query{_metadata{lastProcessedHeight chain} blocks(first:1,filter:{id:{equalTo:"%d"}}){nodes{id timestamp}}}' % cutoff,
                           transport=transport)
    if int(head["_metadata"]["lastProcessedHeight"]) < cutoff:
        raise ProbeError("Indexer is behind the saved cutoff; history results would be incomplete")
    blocks = (head.get("blocks") or {}).get("nodes") or []
    if len(blocks) != 1 or int(blocks[0]["id"]) != cutoff:
        raise ProbeError("The cutoff block is not indexed. Stop; do not guess its time.")
    cutoff_time = iso(date(blocks[0]["timestamp"]))  # The catalog requires an explicit zone.
    targets = [r for r in report["applicationGroups"] if r["covered"] == 0][:max_groups]
    query = ('query($b:Datetime,$apps:[String],$services:[String]){getNetworkSessionsJson('
             'rangeEnd:$b,applications:$apps,services:$services,byService:true,byApplication:true)}')
    results, requests = [], 1+len(targets)
    for row in targets:
        answer = graphql_request(query, {"b": cutoff_time, "apps": [row["applicationId"]], "services": [row["serviceId"]]}, transport)["getNetworkSessionsJson"]
        if answer["range"].get("gaps"):
            raise ProbeError("Session catalog reports a settlement gap; history results would be incomplete")
        rows = [r for r in answer["data"] if r["application_id"] == row["applicationId"] and r["service_id"] == row["serviceId"]]
        count = sum(int(r["paid"])+int(r["settled_zero"]) for r in rows)
        if any(int(r["last_height"] or 0) > cutoff for r in rows):
            # Sessions started shortly before the cutoff block settle after it (about 50
            # blocks later): remove their seats so the count is through the cutoff.
            late = graphql_request(LATE_QUERY, {"a": iso(date(cutoff_time)-timedelta(hours=2)), "b": cutoff_time,
                                                "apps": [row["applicationId"]], "services": [row["serviceId"]]}, transport)["getSessionRostersJson"]
            if late["range"].get("gaps") or len(late["data"]) >= 1000:
                raise ProbeError("Cannot isolate the sessions settled after the cutoff")
            count -= sum(state in ("paid", "settled_zero") for r in late["data"]
                         if r["settled_height"] is not None and int(r["settled_height"]) > cutoff for state in r["member_states"])
            requests += 1
            if count < 0:
                raise ProbeError("Late-settlement correction exceeds the history count")
        results.append({"serviceId": row["serviceId"], "applicationId": row["applicationId"],
                        "indexedHistoryCountThroughCutoff": count,
                        "historyCoveredFrom": answer["range"]["covered_from"],
                        "interpretation": "Indexed history only, from the catalog's first roster. Not a monthly total, verified inactivity, or a replacement for unknown session payouts."})
    return {"checkedAt": datetime.now(timezone.utc).isoformat(), "cutoff": cutoff,
            "indexerMetadata": head["_metadata"], "requestCount": requests, "results": results}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--output", type=Path, default=Path("analysis-output"))
    args = parser.parse_args()
    snapshot, sha = load_snapshot(args.snapshot)
    print(json.dumps(validate_snapshot(snapshot)))
    report = analyse(snapshot, sha)
    write_outputs(report, args.output)
    print(json.dumps({"overall": report["overall"], "neverCoveredGroups": report["neverCoveredGroupCount"],
                      "unknownInNeverCoveredGroups": report["unknownInNeverCoveredGroups"], "output": str(args.output)}))
