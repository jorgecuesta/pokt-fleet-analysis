#!/usr/bin/env python3
"""Claim-first, read-only extraction; does not replace the sampled website.

Python 3.10+, standard library only. Uses the original collector's audited HTTP
cache, retries and endpoint parser. Every session of the pocketdex session
catalog in the service/session-end window is paginated, regardless of
Application; members in a settled state are its settled claims. Historical
membership comes from each session's catalog roster and the members' service
config history, not an interpolated Supplier registry. Amounts remain integer uPOKT.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import sqlite3
import time
from collections import Counter, defaultdict
from datetime import timedelta
from pathlib import Path

from pokt_live_collector import (
    Client, FIXED_SERVICES, GRAPHQL,
    atomic_json, digest, dt, iso, normalized_registry, read_json, suffix_rules, utcnow,
)
from session_catalog import (
    PAGE_SIZE, PARAMS_QUERY, ROSTER_ERA_HEIGHT, block_times, config_at, nat, network_settled_seats, param_at,
    roster_page, session_claims, settled_seats, supplier_configs,
)

VERSION = "settlement-first-1.0"
PRODUCT_SHA256 = "feeebfbb120044a782dd60f1879c0613924cb259b7eb528d5f74659055842088"
CUTOFF = 955836
MONTH_START = "2026-09-06T00:00:00Z"
END = "2026-10-06T00:00:00Z"
PILOT_START = "2026-09-29T00:00:00Z"


def log(message):
    print(message,flush=True)


def plan(stage="pilot"):
    if stage not in {"pilot", "month"}:
        raise ValueError("Choose pilot or month")
    return {"version": VERSION, "stage": stage, "cutoff": CUTOFF,
            "start": PILOT_START if stage == "pilot" else MONTH_START,
            "endExclusive": END, "services": ["eth"] if stage == "pilot" else FIXED_SERVICES,
            "membershipTime": "session catalog roster; owner and endpoints at session start",
            "scope": "all indexed settled claims in service/session-end window",
            "referenceProductSha256": PRODUCT_SHA256}


def resolve_boundaries(client, config):
    fields = []
    for alias, value in (("start", config["start"]), ("end", config["endExclusive"])):
        upper = iso(dt(value) + timedelta(minutes=10))
        fields.append(alias+':blocks(first:100,filter:{timestamp:{greaterThanOrEqualTo:'+json.dumps(value)+',lessThan:'+json.dumps(upper)+'}})'
                      '{totalCount pageInfo{hasNextPage} nodes{id timestamp}}')
    data = client.gql("{" + " ".join(fields) + "}")
    bounds = {}
    for alias, value in (("start", config["start"]), ("end", config["endExclusive"])):
        conn = data[alias]
        rows = sorted(conn["nodes"], key=lambda r: nat(r["id"], "block height"))
        if not rows or nat(conn["totalCount"], "boundary count") != len(rows) or conn["pageInfo"]["hasNextPage"] is not False:
            raise ValueError("UTC boundary is empty or truncated")
        if any(not dt(value) <= dt(r["timestamp"]) < dt(value)+timedelta(minutes=10) for r in rows):
            raise ValueError("Boundary timestamp outside its bracket")
        if any(nat(b["id"], "height") != nat(a["id"], "height")+1 or dt(b["timestamp"]) < dt(a["timestamp"])
               for a, b in zip(rows, rows[1:])):
            raise ValueError("Missing, repeated or unordered boundary blocks")
        bounds[alias] = {"height": nat(rows[0]["id"], "height"), "timestamp": iso(dt(rows[0]["timestamp"]))}
    if not bounds["start"]["height"] < bounds["end"]["height"] <= config["cutoff"]:
        raise ValueError("Boundary heights disagree with the fixed cutoff")
    return bounds


def connect(path, config):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript('''
    CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS services (service TEXT PRIMARY KEY,total INTEGER,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pages (service TEXT,page INTEGER,next_cursor TEXT,row_count INTEGER,hash TEXT,
      PRIMARY KEY(service,page));
    CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY,session TEXT,service TEXT,app TEXT,
      end_height INTEGER,supplier TEXT,json TEXT NOT NULL,page INTEGER,position INTEGER,UNIQUE(session,supplier));
    CREATE INDEX IF NOT EXISTS claim_session ON claims(session);
    CREATE TABLE IF NOT EXISTS sessions (session TEXT PRIMARY KEY,service TEXT NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rosters (session TEXT PRIMARY KEY,json TEXT NOT NULL,hash TEXT NOT NULL);
    ''')
    encoded = json.dumps(config, sort_keys=True)
    existing = db.execute("SELECT json FROM config WHERE id=1").fetchone()
    if existing and existing[0] != encoded:
        db.close()
        raise ValueError("Resume database belongs to another plan")
    with db:
        db.execute("INSERT OR IGNORE INTO config VALUES(1,?)", (encoded,))
    return db


def download_service(client, db, config, service, bounds, progress=log):
    # Sessions are selected by END height; the catalog pages by session START, so the
    # start range opens one hour early and the window is applied to end_height here.
    # It also closes two hours late: full coverage there proves the catalog has written
    # every session that ends inside the window.
    start = iso(dt(bounds["start"]["timestamp"])-timedelta(hours=1))
    end = iso(dt(bounds["end"]["timestamp"])+timedelta(hours=2))
    state = db.execute("SELECT total,status FROM services WHERE service=?", (service,)).fetchone()
    if state and state[1] == "complete":
        return state[0]
    previous = db.execute("SELECT page,next_cursor FROM pages WHERE service=? ORDER BY page DESC LIMIT 1", (service,)).fetchone()
    stored = db.execute("SELECT count(*) FROM claims WHERE service=?", (service,)).fetchone()[0]
    with db:
        db.execute("INSERT OR IGNORE INTO services VALUES(?,?,?)", (service, None, "collecting"))
    page = previous[0]+1 if previous else 0
    # The cursor also carries the oldest session end seen and the settled seats counted
    # so far, so a resumed run keeps both checks below.
    before, oldest, seats = None, None, 0
    if previous:
        height, session, oldest, seats = previous[1].split(":")
        before, oldest, seats = (int(height), session), int(oldest), int(seats)
    for _ in range(10000):
        rows = roster_page(client, start, end, [service], before=before)
        kept = [r for r in rows if bounds["start"]["height"] <= nat(r["end_height"], "end") < bounds["end"]["height"]]
        claims = [c for r in kept for c in session_claims(r, config, service)]
        times = block_times(client, [c["blockId"] for c in claims], config, window=False) if claims else {}
        for c in claims:
            c["block"] = {"timestamp": times[int(c["blockId"])]}
        done = len(rows) < PAGE_SIZE
        oldest = nat(rows[-1]["end_height"], "end") if rows else oldest
        seats += settled_seats(rows, config["start"], config["endExclusive"])
        if done and (oldest is None or oldest >= bounds["start"]["height"]):
            raise ValueError("Session catalog start range does not reach before the window")
        # Completeness: the pages hold every settled seat the catalog totals for these session starts.
        if done and seats != network_settled_seats(client, config["start"], config["endExclusive"], service):
            raise ValueError("Session catalog pages and its network total disagree; keep this run for investigation")
        stored += len(claims)
        cursor = f"{rows[-1]['start_height']}:{rows[-1]['session_id']}:{oldest}:{seats}" if rows else None
        # A whole page and its checkpoint commit together. Duplicates roll back.
        with db:
            for r in kept:
                if any(c["sessionId"] == r["session_id"] for c in claims):
                    db.execute("INSERT INTO sessions VALUES(?,?,?)", (r["session_id"], service, json.dumps(r, separators=(",", ":"))))
            for position, c in enumerate(claims):
                db.execute("INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?)",
                           (c["id"], c["sessionId"], service, c["applicationId"], int(c["sessionEndHeight"]),
                            c["supplierId"], json.dumps(c, separators=(",", ":")), page, position))
            db.execute("INSERT INTO pages VALUES(?,?,?,?,?)", (service, page, cursor, len(claims), digest(claims)))
            if done:
                db.execute("UPDATE services SET total=?,status='complete' WHERE service=?", (stored, service))
        if page % 5 == 0 or done:
            progress(f"{service}: {stored:,} settled claims · catalog page {page+1}; cached progress retained")
        if done:
            return stored
        before, page = (nat(rows[-1]["start_height"], "start"), rows[-1]["session_id"]), page+1
    raise ValueError("Session catalog extraction exceeded the page limit")


def fetch_rosters(client, db, config, progress=log):
    sessions = [json.loads(r[0]) for r in db.execute("SELECT json FROM sessions ORDER BY session")]
    saved = {r[0] for r in db.execute("SELECT session FROM rosters")}
    remaining = [r for r in sessions if r["session_id"] not in saved]
    times = block_times(client, [r["end_height"] for r in remaining], config)
    history = client.gql(PARAMS_QUERY, keys=["num_suppliers_per_session"])["getParamHistoryList"] if remaining else []
    configs = supplier_configs(client, [(m, r["service_id"]) for r in remaining for m in r["member_ids"]], progress)
    with db:
        for r in remaining:
            end, start, service = nat(r["end_height"], "end"), nat(r["start_height"], "start"), r["service_id"]
            if not 1 < start <= end:
                raise ValueError("Historical session header is invalid")
            cap = param_at(history, "session", "num_suppliers_per_session", start)
            if nat(r["roster_size"], "roster size") > cap:
                raise ValueError("Historical roster exceeds the effective session cap")
            # The roster and its configs are fixed at the session start; the owner is the
            # catalog's owner at the start (the archive roster read it at the end height).
            members = normalized_registry([{"operator_address": supplier, "owner_address": owner,
                                            "services": [{"service_id": service, "endpoints": config_at(configs, supplier, service, start)}]}
                                           for supplier, owner in zip(r["member_ids"], r["member_owner_ids"])], [service])
            if {m["id"] for m in members} != set(r["member_ids"]):
                raise ValueError("A selected Supplier lacks its service-specific historical configuration")
            at = times[end]
            if not dt(config["start"]) <= dt(at) < dt(config["endExclusive"]):
                raise ValueError("Session end block does not match the exact UTC window")
            roster = {"id": r["session_id"], "serviceId": service, "applicationId": r["application_id"], "endHeight": end,
                      "startHeight": start, "endedAt": at, "selectedCount": len(members), "selectionCap": cap,
                      "members": members, "membershipSource": "session catalog roster and supplier config history at session start"}
            db.execute("INSERT INTO rosters VALUES(?,?,?)", (roster["id"], json.dumps(roster, separators=(",", ":")), digest(roster)))
    progress(f"Historical rosters: {len(sessions):,}/{len(sessions):,} · owner and endpoint membership verified")
    for sid, text, checksum in db.execute("SELECT session,json,hash FROM rosters"):
        roster = json.loads(text)
        if digest(roster) != checksum:
            raise ValueError("Cached historical roster checksum mismatch")
        ids = {m["id"] for m in roster["members"]}
        if not {r[0] for r in db.execute("SELECT supplier FROM claims WHERE session=?", (sid,))}.issubset(ids):
            raise ValueError("A settled Supplier is absent from the historical roster")
    return len(sessions)


def load_reference(path):
    reference = read_json(path)
    if reference["productSha256"] != PRODUCT_SHA256 or reference["cutoff"] != CUTOFF:
        raise ValueError("Expected the exact original monthly reference")
    return reference


def reconcile_reference(db, config, reference):
    compared, covered, membership_differences = 0, 0, []
    suppliers = reference["supplierIds"]
    for original in reference["sessions"]:
        if original["serviceId"] not in config["services"] or not dt(config["start"]) <= dt(original["observedAt"]) < dt(config["endExclusive"]):
            continue
        # Original sampled sessions at month edges use numeric end membership.
        rows = [json.loads(r[0]) for r in db.execute("SELECT json FROM claims WHERE session=?", (original["id"],))]
        if len(rows) != original["settledClaimCount"]:
            raise ValueError(f"Original indexed claim count changed for {original['id']}")
        compared += 1
        if original["payoutStatus"] != "complete":
            continue
        actual = {r["supplierId"]: nat(r["payoutUpokt"], "payout") for r in rows}
        expected = {suppliers[i]: nat(v, "reference payout") for i, v in original["payouts"]}
        if actual != expected or not all(r["payoutVerified"] for r in rows):
            raise ValueError("Original Supplier distributions do not reconcile exactly in uPOKT")
        saved = db.execute("SELECT json FROM rosters WHERE session=?", (original["id"],)).fetchone()
        if not saved:
            raise ValueError("Overlapping settled session lacks historical roster")
        roster = json.loads(saved[0])
        if {m["id"] for m in roster["members"]} != {suppliers[i] for i, _, _ in original["members"]}:
            raise ValueError("Original selected roster does not reconcile")
        old = {suppliers[i]: (reference["ownerIds"][o], set(endpoints)) for i, o, endpoints in original["members"]}
        for m in roster["members"]:
            current = (m["owner"], {e["id"] for e in m["endpoints"]})
            if current != old[m["id"]]:
                membership_differences.append({"sessionId": original["id"], "supplierId": m["id"],
                    "reason": "sample-time and session-end owner/endpoint observations differ"})
        covered += 1
    return {"sampledSessionsChecked": compared, "coveredSessionsReconciled": covered,
            "membershipDifferences": membership_differences,
            "passed": compared > 0 and covered > 0 and not membership_differences}


def compact_evidence(db, config):
    supplier_index, owner_index, endpoints, sessions = {}, {}, {}, []
    verified_claims, unknown_claims = 0, 0
    group_counts = Counter()
    for (text,) in db.execute("SELECT json FROM rosters ORDER BY session"):
        roster = json.loads(text)
        claims = [json.loads(r[0]) for r in db.execute("SELECT json FROM claims WHERE session=? ORDER BY supplier", (roster["id"],))]
        verified = all(c["payoutVerified"] for c in claims)
        verified_claims += sum(c["payoutVerified"] for c in claims)
        unknown_claims += sum(not c["payoutVerified"] for c in claims)
        memberships = []
        for member in sorted(roster["members"], key=lambda m: m["id"]):
            si = supplier_index.setdefault(member["id"], len(supplier_index))
            oi = owner_index.setdefault(member["owner"], len(owner_index))
            for e in member["endpoints"]:
                if e["id"] in endpoints and endpoints[e["id"]] != e:
                    raise ValueError("Endpoint identity collision")
                endpoints[e["id"]] = e
            memberships.append([si, oi, sorted(e["id"] for e in member["endpoints"])])
        payouts = [[supplier_index[c["supplierId"]], c["payoutUpokt"]] for c in claims] if verified else []
        pool = str(sum(nat(c["payoutUpokt"], "payout") for c in claims)) if verified else None
        for c in claims:
            group_counts[(c["serviceId"], c["applicationId"])] += 1
        sessions.append({"id": roster["id"], "serviceId": roster["serviceId"], "applicationId": roster["applicationId"],
            "sessionEndHeight": roster["endHeight"], "endedAt": roster["endedAt"], "selectedCount": roster["selectedCount"],
            "members": memberships, "payouts": payouts, "poolUpokt": pool,
            "indexedClaimCount": len(claims), "payoutStatus": "verified" if verified else "unknown",
            "outcomeAvailableAt": max(iso(dt(c["block"]["timestamp"])) for c in claims)})
    return {"schemaVersion": 1, "codec": "settlement-session-v1", "dataKind": "live",
        "version": VERSION, "config": config, "supplierIds": list(supplier_index), "ownerIds": list(owner_index),
        "endpointCatalog": sorted(endpoints.values(), key=lambda e: e["id"]),
        "sessions": sorted(sessions, key=lambda s: (s["endedAt"], s["id"])),
        "groups": [{"serviceId": s, "applicationId": a, "claimCount": n} for (s, a), n in sorted(group_counts.items())],
        "coverage": {"indexedClaims": verified_claims+unknown_claims, "verifiedDistributionClaims": verified_claims,
                     "unknownDistributionClaims": unknown_claims, "indexedSettledSessions": len(sessions),
                     "verifiedDistributionSessions": sum(s["payoutStatus"] == "verified" for s in sessions)},
        "notice": "Indexed settled-session earnings only. Sessions absent from the index are outside this denominator, not verified zero. This is not all relays or registered-session presence. No eligible population is inferred; selection models remain in the original sampled snapshot."}


def reconcile_monthly_counts(evidence, reference):
    actual = {(g["serviceId"], g["applicationId"]): g["claimCount"] for g in evidence["groups"]}
    known = {(g["serviceId"], g["applicationId"]): g["monthlyClaimCount"] for g in reference["monthlyGroups"]}
    for key, count in known.items():
        if actual.get(key, 0) != count:
            raise ValueError("Full-month service extraction differs from the completed monthly count check")
    return {"knownGroupsReconciled": len(known), "knownGroupClaimRecords": sum(known.values()),
            "additionalApplicationGroups": [{"serviceId": s, "applicationId": a, "claimCount": n}
                                          for (s, a), n in sorted(actual.items()) if (s, a) not in known]}


def verify_database(db):
    for service, total, status in db.execute("SELECT service,total,status FROM services"):
        if status != "complete" or db.execute("SELECT count(*) FROM claims WHERE service=?", (service,)).fetchone()[0] != total:
            raise ValueError("Incomplete service extraction")
        for page, count, expected in db.execute("SELECT page,row_count,hash FROM pages WHERE service=? ORDER BY page", (service,)):
            rows = [json.loads(r[0]) for r in db.execute("SELECT json FROM claims WHERE service=? AND page=? ORDER BY position", (service, page))]
            if len(rows) != count or digest(rows) != expected:
                raise ValueError("Cached claim page hash or order mismatch")


def verify_pilot_report(path):
    path = Path(path)
    proof = read_json(path)
    if proof.get("status") != "reconciled" or proof.get("config") != plan("pilot") or not proof.get("overlap", {}).get("passed"):
        raise ValueError("A successful matching live pilot report is required")
    if proof.get("coverage", {}).get("unknownDistributionClaims") != 0:
        raise ValueError("Resolve unknown pilot distributions before monthly expansion")
    name = proof.get("artifact", "")
    if not isinstance(name, str) or not name or Path(name).name != name:
        raise ValueError("Pilot evidence must be a local file beside its receipt")
    artifact = path.parent/name
    if not artifact.is_file():
        raise ValueError("Pilot evidence is missing; retain both the receipt and its artifact")
    if hashlib.sha256(artifact.read_bytes()).hexdigest() != proof.get("artifactSha256"):
        raise ValueError("Pilot evidence checksum differs from its receipt")
    evidence = read_json(artifact)
    if (evidence.get("codec") != "settlement-session-v1" or evidence.get("config") != plan("pilot")
            or evidence.get("coverage") != proof["coverage"]):
        raise ValueError("Pilot evidence scope or coverage differs from its receipt")
    return proof


def run(root, stage, reference_path, pilot_report=None, progress=log):
    config = plan(stage)
    reference = load_reference(reference_path)
    if stage == "month":
        if pilot_report is None:
            raise ValueError("Run and reconcile the seven-day live pilot first")
        verify_pilot_report(pilot_report)
    root = Path(root)
    run_dir = root / "runs" / digest(config)[:16]
    run_dir.mkdir(parents=True, exist_ok=True)
    state = {"version": VERSION, "config": config, "status": "running", "startedAt": iso(utcnow())}
    state["collectorSha256"]=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    started = time.perf_counter()
    client = Client(root, workers=2)
    db = connect(run_dir/"claims.sqlite3", config)
    try:
        suffix_rules()
        meta = client.gql('{_metadata{chain lastProcessedHeight}}', fresh=True)["_metadata"]
        if meta["chain"] != "pocket" or nat(meta["lastProcessedHeight"], "indexer height") < config["cutoff"]:
            raise ValueError("Wrong chain or indexer behind the fixed cutoff")
        bounds = resolve_boundaries(client, config)
        if bounds["start"]["height"] < ROSTER_ERA_HEIGHT:
            raise ValueError("Window predates the catalog's session rosters")
        state.update(boundaryBlocks=bounds, indexerMetadata=meta,
                     rosterSource={"api": GRAPHQL, "function": "getSessionRostersJson", "rostersFromHeight": ROSTER_ERA_HEIGHT})
        atomic_json(run_dir/"run.json", state)
        progress(f"{stage}: {config['start']} to {config['endExclusive']} exclusive · cutoff {config['cutoff']} · {config['services']}")
        for service in config["services"]:
            download_service(client, db, config, service, bounds, progress)
        verify_database(db)
        fetch_rosters(client, db, config, progress)
        overlap = reconcile_reference(db, config, reference)
        evidence = compact_evidence(db, config)
        state.update(overlap=overlap,coverage=evidence["coverage"])
        if not overlap["passed"] or evidence["coverage"]["unknownDistributionClaims"]:
            raise ValueError("Reconciliation needs review; inspect cached claims and membership before expansion")
        monthly = reconcile_monthly_counts(evidence, reference) if stage == "month" else None
        artifact = run_dir/"settlement-evidence.json.gz"
        atomic_json(artifact, evidence)
        state.update(status="reconciled", completedAt=iso(utcnow()), overlap=overlap, monthlyCounts=monthly,
                     coverage=evidence["coverage"], artifact=artifact.name,
                     artifactSha256=hashlib.sha256(artifact.read_bytes()).hexdigest(),
                     metrics={"seconds": round(time.perf_counter()-started, 2), "httpAttempts": len(client.metrics),
                              "wireBytes": sum(m["bytes"] for m in client.metrics), "compressedBytes": artifact.stat().st_size},
                     productUpdate="Not installed. Review the new settled-session scope separately from sampled selection.")
        atomic_json(run_dir/"result.json", state)
        atomic_json(run_dir/"run.json", state)
        progress(json.dumps(state, indent=2))
        return state
    except BaseException as exc:
        state.update(status="failed", errorType=type(exc).__name__, error=str(exc), failedAt=iso(utcnow()))
        atomic_json(run_dir/"run.json", state)
        progress(f"Stopped: {type(exc).__name__}: {exc}. Cached pages and rosters remain in {run_dir}. Rerun the same stage to resume.")
        raise
    finally:
        db.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--stage", choices=["pilot", "month"], default="pilot")
    p.add_argument("--root", type=Path, default=Path("pokt-settlement-work/cache"))
    p.add_argument("--reference", type=Path, required=True)
    p.add_argument("--pilot-report", type=Path)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    if args.dry_run:
        print(json.dumps(plan(args.stage), indent=2))
    else:
        run(args.root, args.stage, args.reference, args.pilot_report)


if __name__ == "__main__":
    main()
