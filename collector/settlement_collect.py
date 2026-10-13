#!/usr/bin/env python3
"""Claim-first, read-only extraction; does not replace the sampled website.

Python 3.10+, standard library only. Uses the original collector's audited HTTP
cache, retries, archive-height checks and endpoint parser without editing it.
Every indexed claim in the service/session-end window is paginated, regardless
of Application. Historical membership comes from each selected session's REST
roster, not an interpolated Supplier registry. Amounts remain integer uPOKT.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
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
    Client, FIXED_SERVICES, PAYOUT_REASONS, SUPPORTED_PROTOCOL_COMMIT,
    atomic_json, digest, dt, iso, normalized_registry, read_json, suffix_rules, utcnow,
)

VERSION = "settlement-first-1.0"
PRODUCT_SHA256 = "059ffa4dba60e0c4e3f0f3810cdf778c87d09560c65a701735de5777b84b3b57"
CUTOFF = 955836
MONTH_START = "2026-09-06T00:00:00Z"
END = "2026-10-06T00:00:00Z"
PILOT_START = "2026-09-29T00:00:00Z"
PAGE_SIZE = 500


def log(message):
    print(message,flush=True)

CLAIMS_QUERY = '''query($filter:EventClaimSettledFilter!,$after:Cursor,$first:Int!,
 $payout:ModToAcctTransferFilter!,$relay:ModToAcctTransferFilter!,$global:ModToAcctTransferFilter!){
 eventClaimSettleds(first:$first,after:$after,orderBy:ID_ASC,filter:$filter){
 pageInfo{hasNextPage endCursor} nodes{
 id supplierId serviceId applicationId sessionId sessionEndHeight blockId
 numEstimatedRelays numEstimatedComputedUnits settledAmount settledDenom block{timestamp}
 allTransfers:modToAcctTransfers{totalCount}
 unknownTransfers:modToAcctTransfers(filter:{opReason:{equalTo:UNSPECIFIED}}){totalCount}
 supplierTransfers:modToAcctTransfers(filter:$payout){totalCount aggregates{sum{amount}}}
 relayTransfers:modToAcctTransfers(filter:$relay){totalCount aggregates{sum{amount}}}
 globalTransfers:modToAcctTransfers(filter:$global){totalCount aggregates{sum{amount}}}
 }}}'''
COUNT_QUERY = '''query($filter:EventClaimSettledFilter!){
 eventClaimSettleds(first:1,filter:$filter){totalCount}}'''
BLOCKS_QUERY = '''query($filter:BlockFilter!){blocks(first:200,filter:$filter){
 totalCount pageInfo{hasNextPage} nodes{id timestamp}}}'''


def nat(value, label):
    if isinstance(value, bool) or not str(value).isdigit():
        raise ValueError(f"{label} must be a nonnegative integer, got {value!r}")
    return int(value)


def plan(stage="pilot"):
    if stage not in {"pilot", "month"}:
        raise ValueError("Choose pilot or month")
    return {"version": VERSION, "stage": stage, "cutoff": CUTOFF,
            "start": PILOT_START if stage == "pilot" else MONTH_START,
            "endExclusive": END, "services": ["eth"] if stage == "pilot" else FIXED_SERVICES,
            "membershipTime": "session-end archive height",
            "scope": "all indexed settled claims in service/session-end window",
            "referenceProductSha256": PRODUCT_SHA256}


def claim_filter(config, service, bounds):
    return {"serviceId": {"equalTo": service},
            "sessionEndHeight": {"greaterThanOrEqualTo": str(bounds["start"]["height"]),
                                 "lessThan": str(bounds["end"]["height"])},
            "blockId": {"lessThanOrEqualTo": str(config["cutoff"])}}


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


def transfers(conn):
    count = nat(conn["totalCount"], "transfer count")
    amount = conn["aggregates"]["sum"]["amount"]
    if amount is None and count:
        raise ValueError("Missing transfer aggregate")
    amount = nat(amount or 0, "transfer amount")
    if not count and amount:
        raise ValueError("Nonzero aggregate for an empty transfer set")
    return count, amount


def normalize_claim(raw, config, service, bounds):
    row = json.loads(json.dumps(raw))
    if not all(isinstance(row.get(k), str) and row[k] for k in ("id", "supplierId", "sessionId", "applicationId")):
        raise ValueError("Claim identity is missing")
    end, block = nat(row["sessionEndHeight"], "session end"), nat(row["blockId"], "settlement block")
    if row["serviceId"] != service or not bounds["start"]["height"] <= end < bounds["end"]["height"] or not end < block <= config["cutoff"]:
        raise ValueError("Claim outside service, session window or cutoff")
    if row["settledDenom"] != "upokt":
        raise ValueError("Unexpected claim denomination")
    nat(row["settledAmount"], "settled amount")
    iso(dt(row["block"]["timestamp"]))  # Reject malformed availability timestamps.
    count, amount = transfers(row["supplierTransfers"])
    relay_count, relay_amount = transfers(row["relayTransfers"])
    global_count, global_amount = transfers(row["globalTransfers"])
    if count != relay_count+global_count or amount != relay_amount+global_amount:
        raise ValueError("Supplier distribution reasons do not reconcile")
    all_count = nat(row["allTransfers"]["totalCount"], "all transfers")
    unknown = nat(row["unknownTransfers"]["totalCount"], "unknown transfers")
    if count > all_count or unknown > all_count:
        raise ValueError("Transfer counts are inconsistent")
    row.update(payoutUpokt=str(amount), payoutTransferCount=count,
               payoutVerified=unknown == 0 and all_count > 0)
    return row


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


def count_claims(client, config, service, bounds):
    return nat(client.gql(COUNT_QUERY, fresh=True, filter=claim_filter(config, service, bounds))
               ["eventClaimSettleds"]["totalCount"], "claim count")


def is_statement_timeout(exc):
    message = str(exc)
    return (message.startswith("GraphQL errors:") and "57014" in message
            and "canceling statement due to statement timeout" in message)


def claim_page(client, variables, size, progress=log):
    # Do not repeat the whole-window count inside every costly transfer page.
    # Counts are checked separately before collection and at final sealing.
    # Only this observed PostgreSQL timeout receives a smaller-page retry;
    # schema and semantic errors stop immediately. The cursor stays unchanged.
    for attempt in range(4):
        try:
            result = client.gql(CLAIMS_QUERY, **variables, first=size)["eventClaimSettleds"]
            return result, size
        except ValueError as exc:
            if not is_statement_timeout(exc) or attempt == 3:
                raise
            size = max(50, size//2)
            progress(f"Indexer statement timeout: retrying the same cursor with {size} claims per page; no records skipped.")
            time.sleep(2*(attempt+1))
    raise AssertionError("Unreachable retry state")


def download_service(client, db, config, service, bounds, progress=log):
    expected = count_claims(client, config, service, bounds)
    state = db.execute("SELECT total,status FROM services WHERE service=?", (service,)).fetchone()
    if state and state[0] != expected:
        raise ValueError("Indexed count changed under the fixed cutoff; keep this run for investigation")
    previous = db.execute("SELECT page,next_cursor,row_count FROM pages WHERE service=? ORDER BY page DESC LIMIT 1", (service,)).fetchone()
    stored = db.execute("SELECT count(*) FROM claims WHERE service=?", (service,)).fetchone()[0]
    if state and state[1] == "complete":
        if stored != expected:
            raise ValueError("Resume claim database is incomplete")
        return expected
    with db:
        db.execute("INSERT OR IGNORE INTO services VALUES(?,?,?)", (service, expected, "collecting"))
    after = previous[1] if previous else None
    page = previous[0]+1 if previous else 0
    page_size = min(PAGE_SIZE, max(50, previous[2])) if previous else PAGE_SIZE
    seen = {r[0] for r in db.execute("SELECT next_cursor FROM pages WHERE service=?", (service,)) if r[0]}
    payout = {"denom": {"equalTo": "upokt"}, "opReason": {"in": PAYOUT_REASONS}}
    reasons = [{"denom": {"equalTo": "upokt"}, "opReason": {"equalTo": reason}} for reason in PAYOUT_REASONS]
    for _ in range(10000):
        conn, page_size = claim_page(client, {"filter":claim_filter(config, service, bounds), "after":after,
                          "payout":payout, "relay":reasons[0], "global":reasons[1]}, page_size, progress)
        if "totalCount" in conn and nat(conn["totalCount"], "page total") != expected:
            raise ValueError("Claim count changed while paginating")
        raw = conn["nodes"]
        info = conn["pageInfo"]
        if not isinstance(raw, list) or len(raw) > page_size or not isinstance(info["hasNextPage"], bool):
            raise ValueError("Invalid claim page")
        rows = [normalize_claim(r, config, service, bounds) for r in raw]
        cursor = info["endCursor"]
        if info["hasNextPage"] and (not raw or not cursor or cursor in seen):
            raise ValueError("Claim cursor made no progress")
        if stored+len(rows) > expected or (not info["hasNextPage"] and stored+len(rows) != expected):
            raise ValueError("Claim pagination count mismatch")
        # A whole page and its checkpoint commit together. Duplicates roll back.
        with db:
            for position, r in enumerate(rows):
                db.execute("INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?)",
                           (r["id"], r["sessionId"], service, r["applicationId"], int(r["sessionEndHeight"]),
                            r["supplierId"], json.dumps(r, separators=(",", ":")), page, position))
            db.execute("INSERT INTO pages VALUES(?,?,?,?,?)", (service, page, cursor, len(rows), digest(rows)))
            if not info["hasNextPage"]:
                db.execute("UPDATE services SET status='complete' WHERE service=?", (service,))
        stored += len(rows)
        if page % 10 == 0 or not info["hasNextPage"]:
            progress(f"{service}: {stored:,}/{expected:,} claims · page {page+1}; cached progress retained")
        if not info["hasNextPage"]:
            return expected
        seen.add(cursor)
        after, page = cursor, page+1
    raise ValueError("Claim extraction exceeded the page limit")


def historical_roster(client, session, config, ended_at=None, verify_cap=False):
    height = session["endHeight"]
    raw = client.rest("/pokt-network/poktroll/session/get_session", height,
                      application_address=session["applicationId"], service_id=session["serviceId"],
                      block_height=height)["session"]
    h = raw["header"]
    if (h["session_id"], h["service_id"], h["application_address"], nat(h["session_end_block_height"], "end")) != (
            session["id"], session["serviceId"], session["applicationId"], height):
        raise ValueError("Claim and historical roster identities do not match")
    start = nat(h["session_start_block_height"], "start")
    if not 1 < start <= height or raw["application"]["address"] != session["applicationId"]:
        raise ValueError("Historical session header or Application is invalid")
    ids = [s["operator_address"] for s in raw["suppliers"]]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("Empty or duplicate historical roster")
    cap=None
    if verify_cap:
        cap = nat(client.rest("/pokt-network/poktroll/session/params", start-1)["params"]["num_suppliers_per_session"], "cap")
        if cap == 0 or len(ids) > cap:
            raise ValueError("Historical roster exceeds the effective session cap")
    members = normalized_registry(raw["suppliers"], [session["serviceId"]])
    if {m["id"] for m in members} != set(ids):
        raise ValueError("A selected Supplier lacks its service-specific historical configuration")
    if any(m["operatorAddressParts"].get("checksumValid") is not True or m["ownerAddressParts"].get("checksumValid") is not True for m in members):
        raise ValueError("Invalid historical Supplier or owner address")
    if ended_at is None:
        header = client.rest(f"/cosmos/base/tendermint/v1beta1/blocks/{height}")["block"]["header"]
        if header["chain_id"] != "pocket" or nat(header["height"], "block height") != height:
            raise ValueError("Historical end block identity mismatch")
        ended_at=header["time"]
    at = iso(dt(ended_at))
    if not dt(config["start"]) <= dt(at) < dt(config["endExclusive"]):
        raise ValueError("Session end block does not match the exact UTC window")
    return {**session, "startHeight": start, "endedAt": at, "selectedCount": len(ids),
            "selectionCap": cap, "members": members, "membershipSource": "archive REST at session end"}


def block_times(client, heights, config):
    times={}
    values=sorted(set(heights))
    for offset in range(0,len(values),200):
        part=values[offset:offset+200]
        conn=client.gql(BLOCKS_QUERY,filter={"id":{"in":[str(h) for h in part]}})["blocks"]
        rows=conn["nodes"]
        if nat(conn["totalCount"],"block count")!=len(part) or len(rows)!=len(part) or conn["pageInfo"]["hasNextPage"] is not False:
            raise ValueError("Historical block timestamp batch is incomplete")
        for row in rows:
            height=nat(row["id"],"block height")
            at=iso(dt(row["timestamp"]))
            if height not in part or height in times or not dt(config["start"])<=dt(at)<dt(config["endExclusive"]):
                raise ValueError("Historical block timestamp is repeated or out of scope")
            times[height]=at
    return times


def fetch_rosters(client, db, config, progress=log):
    sessions = db.execute("SELECT session,min(service),min(app),min(end_height),count(DISTINCT service),count(DISTINCT app),count(DISTINCT end_height) FROM claims GROUP BY session ORDER BY min(end_height),session").fetchall()
    times=block_times(client,[item[3] for item in sessions],config)
    boundary_heights={sessions[0][3],sessions[-1][3]} if sessions else set()
    def fetch(item):
        sid, service, app, height, ns, na, nh = item
        if (ns, na, nh) != (1, 1, 1):
            raise ValueError("Conflicting service, Application or end height for a session")
        return historical_roster(client, {"id": sid, "serviceId": service, "applicationId": app, "endHeight": height}, config,
                                 ended_at=times[height],verify_cap=height in boundary_heights)
    saved_ids=set()
    for sid, text, checksum in db.execute("SELECT session,json,hash FROM rosters"):
        if digest(json.loads(text))!=checksum:
            raise ValueError("Cached historical roster checksum mismatch")
        saved_ids.add(sid)
    remaining=[item for item in sessions if item[0] not in saved_ids]
    completed=len(saved_ids)
    # Bounded batches retain a small memory footprint. Only HTTP runs in worker
    # threads; SQLite mutations stay on the owning thread.
    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        for offset in range(0,len(remaining),20):
            futures=[pool.submit(fetch,item) for item in remaining[offset:offset+20]]
            for future in cf.as_completed(futures):
                roster=future.result()
                with db:
                    db.execute("INSERT INTO rosters VALUES(?,?,?)", (roster["id"],json.dumps(roster,separators=(",",":")),digest(roster)))
                completed+=1
                if completed%10==0 or completed==len(sessions):
                    progress(f"Historical rosters: {completed:,}/{len(sessions):,} · owner and endpoint membership verified")
    for sid, *_ in sessions:
        roster=json.loads(db.execute("SELECT json FROM rosters WHERE session=?",(sid,)).fetchone()[0])
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
        version = client.rest('/cosmos/base/tendermint/v1beta1/node_info', fresh=True)["application_version"]
        applied = nat(client.rest('/cosmos/upgrade/v1beta1/applied_plan/v0.1.35')["height"], "upgrade height")
        if version.get("git_commit") != SUPPORTED_PROTOCOL_COMMIT or version.get("version") != "0.1.35":
            raise ValueError("Protocol version changed; review the historical API before continuing")
        bounds = resolve_boundaries(client, config)
        if bounds["start"]["height"] < applied:
            raise ValueError("Window predates the validated protocol era")
        state.update(boundaryBlocks=bounds, indexerMetadata=meta, protocolVerification={k:version[k] for k in ('version','git_commit')})
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
        for service in config["services"]:
            count = count_claims(client, config, service, bounds)
            if count != db.execute("SELECT total FROM services WHERE service=?", (service,)).fetchone()[0]:
                raise ValueError("Final indexed count changed during extraction")
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
