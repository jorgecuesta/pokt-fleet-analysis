"""Verify a review ZIP offline. Only a reconciled 30-day, eight-service ZIP may be installed.

    python scripts/import-settlement-month.py /path/to/review-results.zip --check-only

No API requests are made, and the original selection snapshot is never overwritten.
"""
import argparse
import gzip
import hashlib
import json
import sys
import zipfile
from collections import Counter
from datetime import datetime, timedelta
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "analysis"))
from settlement_product import unpack

SAMPLE_SHA = "feeebfbb120044a782dd60f1879c0613924cb259b7eb528d5f74659055842088"
SERVICES = {"arb-one", "base", "bsc", "eth", "opbnb", "poly", "robinhood", "solana"}


def stamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("A UTC timestamp is required")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_prior_stage(raw, earlier, receipt, month_config):
    require(receipt is not None and hashlib.sha256(raw).hexdigest() == receipt.get('artifactSha256'), 'Fortnight checksum differs from receipt')
    config = earlier['config']
    require(config == receipt['config'] and receipt['status'] == 'reconciled' and receipt['overlap']['passed'] is True, 'Fortnight receipt is not reconciled')
    require(stamp(config['start']) == stamp(month_config['endExclusive']) - timedelta(days=14) and
            config['endExclusive'] == month_config['endExclusive'] and config['cutoff'] == month_config['cutoff'] and
            config['referenceProductSha256'] == month_config['referenceProductSha256'] and
            set(config['services']) == set(month_config['services']), 'Fortnight frame differs')
    coverage = earlier['coverage']
    require(coverage == receipt['coverage'] and coverage['unknownDistributionClaims'] == 0 and
            coverage['indexedSettledSessions'] == len(earlier['sessions']) and
            coverage['indexedClaims'] == sum(row['indexedClaimCount'] for row in earlier['sessions']), 'Fortnight coverage differs')


def verify(path):
    sample_bytes = (ROOT / "data/live-snapshot.json.gz").read_bytes()
    require(hashlib.sha256(sample_bytes).hexdigest() == SAMPLE_SHA, "Original sample checksum differs")
    reference = json.loads(gzip.decompress((ROOT / "collector/settlement-reference.json.gz").read_bytes()))
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        require(len(names) == len(set(names)), "ZIP has duplicate entries")
        require(all(not Path(n).is_absolute() and ".." not in Path(n).parts for n in names), "Unsafe ZIP path")
        require(sum(n.file_size for n in z.infolist()) < 600_000_000, "ZIP exceeds review extraction budget")
        prefix = "stages/30d" if "stages/30d/result.json" in names else "stages/14d" if "stages/14d/result.json" in names else "reviewed-pilot"
        receipt = json.loads(z.read(prefix + "/result.json"))
        raw = z.read(prefix + "/settlement-evidence.json.gz")
        packed_bytes = z.read("indexed-settlements-product.json.gz")
        wire = json.loads(gzip.decompress(packed_bytes))
        canonical = json.loads(gzip.decompress(raw))
        readiness = json.loads(z.read("readiness-report.json"))
        investigation = json.loads(z.read("investigation/result.json"))
        require(hashlib.sha256(raw).hexdigest() == receipt["artifactSha256"], "Canonical checksum differs from receipt")
        require(unpack(wire) == canonical, "Packed product does not exactly round-trip to canonical evidence")
        earlier_raw = z.read("stages/14d/settlement-evidence.json.gz") if prefix == "stages/30d" and "stages/14d/settlement-evidence.json.gz" in names else None
        earlier = json.loads(gzip.decompress(earlier_raw)) if earlier_raw else None
        earlier_receipt = json.loads(z.read('stages/14d/result.json')) if earlier and 'stages/14d/result.json' in names else None
    config = canonical["config"]
    require(config == receipt["config"], "Receipt configuration differs")
    require(receipt["status"] == "reconciled" and receipt["overlap"]["passed"] is True, "Collection is not reconciled")
    require(config["referenceProductSha256"] == SAMPLE_SHA and config["cutoff"] == reference["cutoff"], "Reference or cutoff differs")
    require(stamp(config["start"]) >= stamp(reference["period"]["start"]) and stamp(config["endExclusive"]) == stamp(reference["period"]["endExclusive"]), "Unexpected period")
    require(set(config["services"]) <= SERVICES and len(set(config["services"])) == len(config["services"]), "Unexpected services")
    require(investigation["technicalStatus"] == "passed" and investigation["safeToCollectIndexedSettlements"] is True and not investigation["errors"], "Missing-payment investigation did not pass")
    require(readiness["collectionReconciled"] is True, "Readiness receipt is not reconciled")
    suppliers, owners = canonical["supplierIds"], canonical["ownerIds"]
    require(len(set(suppliers)) == len(suppliers) and len(set(owners)) == len(owners), "Duplicate identities")
    require(set(suppliers) <= set(reference["supplierIds"]) and set(owners) <= set(reference["ownerIds"]), "Directory update is required for new identities")
    endpoints = {e["id"]: e for e in canonical["endpointCatalog"]}
    require(len(endpoints) == len(canonical["endpointCatalog"]), "Duplicate endpoint identity")
    records, counts, dates = {}, Counter(), {}
    pool_total, owner_actual, owner_reference = 0, Counter(), {}
    verified_sessions = 0
    for row in canonical["sessions"]:
        require(row["id"] not in records and row["serviceId"] in config["services"], "Duplicate session or unselected service")
        require(stamp(config["start"]) <= stamp(row["endedAt"]) < stamp(config["endExclusive"]), "Session outside UTC frame")
        require(type(row["sessionEndHeight"]) is int and 0 < row["sessionEndHeight"] <= config["cutoff"], "Invalid end height")
        roster = row["members"]
        require(type(row["selectedCount"]) is int and row["selectedCount"] > 0 and len(roster) == row["selectedCount"], "Selected roster does not reconcile")
        require(len({m[0] for m in roster}) == len(roster), "Duplicate selected Supplier")
        owner_for = {}
        for supplier, owner, ids in roster:
            require(type(supplier) is int and 0 <= supplier < len(suppliers) and type(owner) is int and 0 <= owner < len(owners), "Invalid member identity index")
            require(len(ids) == len(set(ids)) and all(e in endpoints and endpoints[e]["serviceId"] == row["serviceId"] for e in ids), "Wrong service or unknown endpoint")
            owner_for[supplier] = owners[owner]
        require(type(row["indexedClaimCount"]) is int and row["indexedClaimCount"] > 0, "Invalid claim count")
        require(row["payoutStatus"] == "verified", "Monthly activation requires attributable distributions for every returned session")
        payouts = row["payouts"]
        require(len({p[0] for p in payouts}) == len(payouts) and all(p[0] in owner_for for p in payouts), "Duplicate or unselected payout")
        require(isinstance(row["poolUpokt"], str) and row["poolUpokt"].isdigit() and all(isinstance(p[1], str) and p[1].isdigit() for p in payouts), "Payout must retain integer upokt")
        pool = int(row["poolUpokt"])
        require(pool == sum(int(p[1]) for p in payouts), "Supplier distributions do not conserve the pool")
        require(row["outcomeAvailableAt"] and stamp(row["outcomeAvailableAt"]) >= stamp(row["endedAt"]), "Settlement precedes session end")
        for supplier, amount in payouts: owner_actual[owner_for[supplier]] += int(amount)
        for owner, positions in Counter(owner_for.values()).items():
            owner_reference[owner] = owner_reference.get(owner, Fraction(0)) + Fraction(pool * positions, row["selectedCount"])
        pool_total += pool; verified_sessions += 1
        records[row["id"]] = row
        counts[(row["serviceId"], row["applicationId"])] += row["indexedClaimCount"]
        dates.setdefault(row["serviceId"], set()).add(row["endedAt"][:10])
    require(sum(owner_actual.values()) == pool_total and sum(owner_reference.values(), Fraction(0)) == pool_total, "Owner partition does not conserve exact amounts")
    for coverage in (canonical["coverage"], receipt["coverage"]):
        require(coverage["indexedClaims"] == sum(counts.values()) and coverage["indexedSettledSessions"] == len(records) and
                coverage["unknownDistributionClaims"] == 0 and coverage["verifiedDistributionSessions"] == verified_sessions and
                coverage["verifiedDistributionClaims"] == sum(counts.values()), "Coverage receipt differs")
    require(readiness["indexedClaims"] == sum(counts.values()) and readiness["indexedSettledSessions"] == len(records), "Readiness totals differ")
    declared = {(g["serviceId"], g["applicationId"]): g["claimCount"] for g in canonical["groups"]}
    require(len(declared) == len(canonical["groups"]) and declared == dict(counts), "Application/service totals differ")
    selected_reference = [r for r in reference["sessions"] if r["serviceId"] in config["services"] and stamp(config["start"]) <= stamp(r["observedAt"]) < stamp(config["endExclusive"])]
    overlap = 0
    for original in selected_reference:
        row = records.get(original["id"])
        require((row["indexedClaimCount"] if row else 0) == original["settledClaimCount"], "Original sampled claim count differs")
        if original["payoutStatus"] == "complete":
            require(row is not None and row["sessionEndHeight"] == original["sessionEndHeight"], "Missing covered overlap")
            expected = {reference["supplierIds"][i]: int(v) for i, v in original["payouts"]}
            actual = {suppliers[i]: int(v) for i, v in row["payouts"]}
            require(actual == expected, "Original sampled payouts differ")
            members_as_ids = lambda roster, sid, oid: {sid[i]: (oid[o], tuple(sorted(ids))) for i, o, ids in roster}
            require(members_as_ids(row["members"], suppliers, owners) == members_as_ids(original["members"], reference["supplierIds"], reference["ownerIds"]), "Historical owner or endpoint overlap differs")
            overlap += 1
    require(receipt["overlap"]["sampledSessionsChecked"] == len(selected_reference) and receipt["overlap"]["coveredSessionsReconciled"] == overlap, "Overlap receipt differs")
    earlier_count = 0
    if earlier:
        verify_prior_stage(earlier_raw, earlier, earlier_receipt, config)
        for row in earlier["sessions"]:
            current = records.get(row["id"])
            require(current is not None, "Fortnight session missing from month")
            normalize = lambda r, evidence: {**r, "members": sorted((evidence["supplierIds"][i], evidence["ownerIds"][o], tuple(sorted(ids))) for i, o, ids in r["members"]), "payouts": sorted((evidence["supplierIds"][i], v) for i, v in r["payouts"])}
            require(normalize(current, canonical) == normalize(row, earlier), "Fortnight and month differ")
            earlier_count += 1
    full_month = stamp(config["start"]) == stamp(reference["period"]["start"]) and set(config["services"]) == SERVICES and (stamp(config["endExclusive"]) - stamp(config["start"])).days == 30
    if full_month:
        require(earlier is not None, "The reviewed 14-day stage must accompany the month")
        require(earlier_receipt['overlap']['sampledSessionsChecked'] == 1904 and
                earlier_receipt['overlap']['coveredSessionsReconciled'] == 752 and earlier_count == 13415,
                'Reviewed fortnight overlap frame is incomplete')
        require(len(selected_reference) == 4080 and overlap == 1652, "Monthly overlap frame is incomplete")
        for g in reference["monthlyGroups"]:
            require(counts[(g["serviceId"], g["applicationId"])] == g["monthlyClaimCount"], "Known monthly group count differs")
        require(set(counts) <= {(g["serviceId"], g["applicationId"]) for g in reference["monthlyGroups"]}, "New Application group requires review")
        require(all(len(dates.get(service, set())) == 30 for service in SERVICES), "Monthly service dates are incomplete")
    audit = {"status":"verified", "monthlyActivationReady":full_month, "claims":sum(counts.values()), "sessions":len(records),
        "sourceWindow":config, "sampledCountsChecked":len(selected_reference), "coveredOverlapsReconciled":overlap,
        "fortnightSessionsReconciled":earlier_count, "fortnightReceiptVerified":earlier is not None, "ownerPartitionsConserveExactly":True,
        "canonicalSha256":hashlib.sha256(raw).hexdigest(), "packedSha256":hashlib.sha256(packed_bytes).hexdigest(),
        "originalSampleSha256":SAMPLE_SHA, "notice":canonical["notice"],
        "originalSampledCoverageUnchanged":{"covered":1652,"sessions":4080},
        "wholeGroupCauseEstablished":investigation["wholeGroupCauseEstablished"]}
    return audit, packed_bytes, receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("review_zip", type=Path)
    parser.add_argument("--check-only", action="store_true", help="Verify any stage without activating it")
    args = parser.parse_args()
    audit, packed, receipt = verify(args.review_zip)
    print(json.dumps(audit, indent=2))
    if args.check_only:
        return
    require(audit["monthlyActivationReady"], "Verified proof only: a full 30-day, eight-service review ZIP is required before installation")
    # All checks above finish before any product data is changed.
    (ROOT / "data/settlement-month.json.gz").write_bytes(packed)
    (ROOT / "data/settlement-month-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (ROOT / "data/settlement-integration.json").write_text(json.dumps(audit, indent=2) + "\n")
    print("Installed separate monthly earnings evidence. Original selection snapshot unchanged. Run npm run build next.")


if __name__ == "__main__":
    main()
