#!/usr/bin/env python3
"""Pocket fleet analysis: reproducible, read-only live collection (Python 3.10+).

No third-party packages, keys or wallet required. This is the NEW Phase 2
collector; original_v5_core.py is the unmodified collection code from V5.

  python pokt_live_collector.py discover --out ./cache
  python pokt_live_collector.py collect --out ./cache --days 30

discover records ALL service metadata and seven mature days of indexed settled
estimated compute units. collect deep-collects services chosen before looking at
fleet earnings, at 03/09/15/21 UTC, for EVERY historically registered Application.
These are sampled sessions, never a monthly earnings census. Missing claims are
unknown, never silently verified zero. Owner-address cohorts are not businesses.

Every response is cached with request, archive height, served height, timestamp,
response hash and wire bytes. Registry snapshots are fetched ONCE per height,
shared across services. Fixed indexer cutoff, cursor checks, single-flight cache,
bounded concurrency, retry/backoff and atomic publication support resumability.
Only a fully successful collection publishes snapshot.json.gz. Failures preserve
completed requests; rerun the EXACT same run.json with --resume.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import gzip
import hashlib
import ipaddress
import json
import os
import re
import random
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from session_catalog import (
    PARAMS_QUERY, ROSTER_ERA_HEIGHT, block_times, config_at, param_at, roster_page, session_claims,
    staked_suppliers, supplier_configs,
)

VERSION = "phase2-1.2"
REGISTRY_SCHEMA_VERSION = 2
PSL_SHA256 = "ba7d836c0ea57a8bcf9f1fcb868066a7554bed029b441ecc6204ad8494a32612"
RESUMABLE_VERSIONS = {"phase2-1.0", "phase2-1.1", VERSION}
CACHE_NAMESPACE = "phase2-1.0"  # Immutable request cache remains reusable across code fixes.
API = "https://sauron-api.infra.pocket.network"
GRAPHQL = "https://data.pocket.network/graphql"
RPC = "https://sauron-rpc.infra.pocket.network"
PAYOUT_REASONS = ["TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_RD",
                  "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION"]
HOURS = [3, 9, 15, 21]
FIXED_SERVICES = ["arb-one", "base", "bsc", "eth", "opbnb", "poly", "robinhood", "solana"]


def utcnow():
    return datetime.now(timezone.utc)


def iso(t):
    return t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def dt(value):
    d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)


def digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(tmp, "wt", encoding="utf-8") as f:
        json.dump(value, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)


def read_json(path):
    path = Path(path)
    with (gzip.open if path.suffix == ".gz" else open)(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def integer(value, label="amount"):
    n = Decimal(str(value))
    if not n.is_finite() or n < 0 or n != n.to_integral_value():
        raise ValueError(f"Invalid nonnegative integer {label}: {value}")
    return int(n)


@lru_cache(maxsize=1)
def suffix_rules():
    """Pinned Public Suffix List, including private suffixes; no network lookup."""
    path = Path(__file__).with_name("public_suffix_list.dat")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != PSL_SHA256:
        raise ValueError("Public Suffix List checksum mismatch; update the reviewed pin explicitly")
    rules = set()
    for line in raw.decode("utf-8").splitlines():
        rule = line.split("//", 1)[0].strip()
        if rule:
            prefix = "!" if rule.startswith("!") else "*." if rule.startswith("*.") else ""
            name = rule[len(prefix):].encode("idna").decode("ascii").lower()
            rules.add(prefix + name)
    return rules, hashlib.sha256(raw).hexdigest()


@lru_cache(maxsize=32768)
def domain_parts(host):
    """PSL prevailing-rule algorithm; IPs and single labels have no domain."""
    try:
        ipaddress.ip_address(host)
        return {"hostKind": "ip", "publicSuffix": None, "registrableDomain": None,
                "subdomain": None, "subdomainLabels": []}
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) < 2:
        return {"hostKind": "single_label", "publicSuffix": None, "registrableDomain": None,
                "subdomain": None, "subdomainLabels": []}
    rules, _ = suffix_rules()
    length = 1  # PSL default rule '*'.
    exceptions = []
    for i in range(len(labels)):
        candidate = ".".join(labels[i:])
        if "!" + candidate in rules:
            exceptions.append(len(labels)-i-1)
        if candidate in rules:
            length = max(length, len(labels)-i)
        if i and "*."+candidate in rules:
            length = max(length, len(labels)-i+1)
    if exceptions:
        length = max(exceptions)
    suffix = ".".join(labels[-length:])
    domain = ".".join(labels[-length-1:]) if len(labels)>length else None
    sublabels = labels[:-length-1] if domain else []
    return {"hostKind": "dns", "publicSuffix": suffix, "registrableDomain": domain,
            "subdomain": ".".join(sublabels), "subdomainLabels": sublabels}


def parse_endpoint(endpoint, service_id):
    """Preserve structural facts, never infer service, business or geography.

    Raw URLs stay in the hashed source response. Public fields omit credentials,
    query values and fragments; the source URL hash preserves their provenance.
    """
    raw = str(endpoint.get("url", ""))
    rpc_type = endpoint.get("rpc_type")
    source_hash = hashlib.sha256(raw.encode()).hexdigest()
    result = {"id": "endpoint:"+digest([service_id, source_hash, rpc_type])[:24],
              "serviceId": service_id, "rpcType": rpc_type, "sourceUrlSha256": source_hash}
    try:
        if any(c.isspace() or ord(c)<32 for c in raw):
            raise ValueError("Endpoint URL contains whitespace or control characters")
        url = urllib.parse.urlsplit(raw)
        if url.scheme.lower() not in ("http", "https", "ws", "wss", "grpc", "grpcs") or not url.hostname:
            raise ValueError("Expected an absolute endpoint URL with a supported transport")
        host = url.hostname.lower().rstrip(".").encode("idna").decode("ascii")
        port = url.port  # Raises on invalid or out-of-range ports.
        if not host or any(c.isspace() for c in host) or any(c in host for c in "/\\?#@"):
            raise ValueError("Invalid endpoint hostname")
        try:
            ip = ipaddress.ip_address(host)
            host = str(ip)
        except ValueError:
            if len(host)>253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")):
                raise ValueError("Invalid DNS hostname")
        authority = "["+host+"]" if ":" in host else host
        if port is not None:
            authority += ":"+str(port)
        redacted = [name for name, present in (("userinfo", url.username is not None or url.password is not None),
                     ("query_values", bool(url.query)), ("fragment", bool(url.fragment))) if present]
        parts=domain_parts(host)
        result.update(parseStatus="parsed", scheme=url.scheme.lower(), hostname=host, port=port,
                      effectivePort=port if port is not None else {"http":80,"https":443,"ws":80,"wss":443}.get(url.scheme.lower()),
                      path=url.path, pathSegments=(url.path.split("/")[1:] if url.path.startswith("/") else url.path.split("/")) if url.path else [],
                      queryKeys=sorted({key for key, _ in urllib.parse.parse_qsl(url.query, keep_blank_values=True)}),
                      redactedParts=redacted, url=urllib.parse.urlunsplit((url.scheme.lower(),authority,url.path,"","")),
                      subdomainTokenGroups=[label.split("-") for label in parts["subdomainLabels"]], **parts)
    except (ValueError, UnicodeError) as exc:
        result.update(parseStatus="invalid", reason=str(exc), hostname=None, registrableDomain=None)
    return result


@lru_cache(maxsize=32768)
def address_parts(address):
    """Validate a Pocket Bech32 account. The payload is opaque, not an actor ID."""
    alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    if (not isinstance(address,str) or len(address)>90 or
            (address.lower()!=address and address.upper()!=address)):
        raise ValueError("Invalid Bech32 account address")
    text=address.lower()
    split=text.rfind("1")
    if split<1 or text[:split]!="pokt" or len(text)-split-1<6:
        raise ValueError("Expected a Pocket account address")
    try:
        values=[alphabet.index(c) for c in text[split+1:]]
    except ValueError as exc:
        raise ValueError("Invalid Bech32 account alphabet") from exc
    prefix=text[:split]
    expanded=[ord(c)>>5 for c in prefix]+[0]+[ord(c)&31 for c in prefix]
    chk=1
    for v in expanded+values:
        top=chk>>25;chk=((chk&0x1ffffff)<<5)^v
        for i,g in enumerate((0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3)):
            if (top>>i)&1:chk^=g
    if chk!=1:
        raise ValueError("Pocket account checksum mismatch")
    acc=bits=0;payload=[]
    for value in values[:-6]:
        acc=(acc<<5)|value;bits+=5
        if bits>=8:
            bits-=8;payload.append((acc>>bits)&255)
    if bits>=5 or ((acc<<(8-bits))&255) or len(payload)!=20:
        raise ValueError("Invalid Pocket account payload or padding")
    return {"encoding":"bech32", "prefix":prefix, "payloadBytes":len(payload),
            "checksumValid":True, "payloadHex":bytes(payload).hex()}


def normalized_registry(suppliers, service_ids):
    registry = []
    for supplier in suppliers:
        configs = [c for c in supplier.get("services", []) if c["service_id"] in service_ids]
        if not configs:
            continue
        endpoints = {e["id"]: e for config in configs for e in
                     (parse_endpoint(endpoint, config["service_id"]) for endpoint in config.get("endpoints", []))}
        endpoints = sorted(endpoints.values(), key=lambda e:e["id"])
        registry.append({"id": supplier["operator_address"], "owner": supplier["owner_address"],
                         "operatorAddressParts": address_parts(supplier["operator_address"]),
                         "ownerAddressParts": address_parts(supplier["owner_address"]),
                         "services": sorted({c["service_id"] for c in configs}),
                         "hosts": sorted({e["hostname"] for e in endpoints if e["hostname"]}), "endpoints": endpoints})
    return registry


def upgrade_point_registry(part, client, service_ids):
    """Recover legacy URL structure at the original height; reuse hashed cache.

    An offline export supplies a cache-only Client. A resumed collector may fetch
    a missing raw response at the SAME historical height, never today's registry.
    """
    if part.get("registrySchemaVersion") == REGISTRY_SCHEMA_VERSION:
        return part
    suppliers = client.pages("/pokt-network/poktroll/supplier/supplier", "supplier",
                             part["point"]["height"], limit=10000, dehydrated="true")
    registry = normalized_registry(suppliers, service_ids)
    before = {r["id"]: (r["owner"], sorted(r["services"])) for r in part["registry"]}
    after = {r["id"]: (r["owner"], sorted(r["services"])) for r in registry}
    if before != after:
        raise ValueError("Legacy point disagrees with its pinned raw registry")
    part.update(registry=registry, registrySchemaVersion=REGISTRY_SCHEMA_VERSION)
    return part


class Client:
    def __init__(self, root, workers=4):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.guard = threading.Lock()
        self.locks = {}
        self.metrics = []
        self.workers = workers

    def keylock(self, key):
        with self.guard:
            return self.locks.setdefault(key, threading.Lock())

    def request(self, url, body=None, height=None, label="http", fresh=False):
        key = digest([CACHE_NAMESPACE, url, body, height, iso(utcnow()) if fresh else None])
        path = self.root / "responses" / key[:2] / (key + ".json.gz")
        with self.keylock(key):
            if path.exists():
                cached = read_json(path)
                if digest(cached["response"]) != cached["response_sha256"]:
                    raise ValueError("Cached response checksum mismatch")
                return cached["response"]
            headers = {"Content-Type": "application/json", "Accept-Encoding": "gzip",
                       "User-Agent": "pokt-fleet-analysis/" + VERSION}
            if height is not None:
                headers["x-cosmos-block-height"] = str(height)
            encoded = None if body is None else json.dumps(body).encode()
            for attempt in range(4):
                started, count, success = time.perf_counter(), 0, False
                try:
                    with urllib.request.urlopen(urllib.request.Request(url, encoded, headers), timeout=90) as response:
                        raw = response.read()
                        count = len(raw)
                        served = response.headers.get("x-cosmos-block-height")
                        content_encoding = response.headers.get("Content-Encoding")
                    if height is not None and served != str(height):
                        raise ValueError(f"Archive did not confirm height {height}: {served}")
                    if content_encoding == "gzip":
                        raw = gzip.decompress(raw)
                    value = json.loads(raw)
                    if value.get("errors"):
                        raise ValueError("GraphQL errors: " + json.dumps(value["errors"])[:900])
                    atomic_json(path, {"url": url, "body": body, "requested_height": height,
                                      "served_height": served, "fetched_at": iso(utcnow()),
                                      "received_bytes": count, "response_sha256": digest(value),
                                      "response": value})
                    success = True
                    return value
                except urllib.error.HTTPError as e:
                    if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                        raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='replace')[:900]}") from e
                    delay = e.headers.get("Retry-After")
                    delay = min(30, int(delay)) if delay and delay.isdigit() else 2 ** attempt
                except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError):
                    if attempt == 3:
                        raise
                    delay = 2 ** attempt
                finally:
                    metric = {"label": label, "url": url.split("?")[0], "height": height,
                              "seconds": round(time.perf_counter() - started, 3), "bytes": count,
                              "success": success, "finished_at": iso(utcnow())}
                    with self.guard:
                        self.metrics.append(metric)
                        with (self.root / "http_metrics.jsonl").open("a") as f:
                            f.write(json.dumps(metric) + "\n")
                time.sleep(delay)

    def rest(self, path, height=None, fresh=False, **params):
        url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
        return self.request(url, height=height, label=path.rsplit("/", 1)[-1], fresh=fresh)

    def gql(self, query, fresh=False, **variables):
        value = self.request(GRAPHQL, {"query": query, "variables": variables}, label="graphql", fresh=fresh)
        if value.get("data") is None:
            raise ValueError("GraphQL returned no data")
        return value["data"]

    def pages(self, path, key, height=None, limit=1000, **params):
        records, cursor, seen, identities = [], None, set(), set()
        for page in range(1000):
            p = {**params, "pagination.limit": limit}
            if cursor:
                p["pagination.key"] = cursor
            result = self.rest(path, height, **p)
            for row in result[key]:
                identity = row.get("operator_address", row.get("address", row.get("id")))
                if not identity or identity in identities:
                    raise ValueError("Duplicate or missing REST registry identity")
                identities.add(identity)
                records.append(row)
            cursor = result.get("pagination", {}).get("next_key")
            if not cursor:
                return records
            if cursor in seen:
                raise ValueError("Repeated REST cursor")
            seen.add(cursor)
        raise ValueError("REST pagination failed to finish")

    def parallel(self, fn, items):
        results = []
        with cf.ThreadPoolExecutor(max_workers=self.workers) as pool:
            tasks = {pool.submit(fn, item): item for item in items}
            for i, future in enumerate(cf.as_completed(tasks), 1):
                results.append(future.result())
                if i % 10 == 0 or i == len(tasks):
                    print(f"Completed {i}/{len(tasks)}", flush=True)
        return results


def indexed_services(client, height):
    """Every registered service at one height, from the indexer's Service entity."""
    rows, total = [], None
    for offset in range(0, 100000, 100):
        conn = client.gql('query($h:String,$o:Int){services(first:100,offset:$o,blockHeight:$h,orderBy:ID_ASC)'
                          '{totalCount nodes{id name computeUnitsPerRelay}}}', h=str(height), o=offset)["services"]
        total = conn["totalCount"] if total is None else total
        if conn["totalCount"] != total:
            raise ValueError("Service count changed while paginating")
        rows.extend({"id": s["id"], "name": s["name"], "compute_units_per_relay": s["computeUnitsPerRelay"]} for s in conn["nodes"])
        if len(rows) >= total or not conn["nodes"]:
            break
    if len(rows) != total or len({s["id"] for s in rows}) != total:
        raise ValueError("Incomplete or repeated service catalogue")
    return rows


def discover(client, end=None, max_services=8, target=.95, cutoff=None):
    indexed = client.gql('{_metadata{lastProcessedHeight chain} blocks(first:1,orderBy:ID_DESC){nodes{id timestamp}}}', fresh=True)
    meta = indexed["_metadata"]
    if meta["chain"] != "pocket":
        raise ValueError("Expected Pocket indexer")
    latest = min(int(meta["lastProcessedHeight"]), int(indexed["blocks"]["nodes"][0]["id"]))
    # A fixed historical cutoff reproduces an earlier collection: services as registered then.
    if cutoff is not None and not 0 < cutoff <= latest:
        raise ValueError(f"Cutoff must be an indexed height no later than {latest}")
    cutoff = latest if cutoff is None else cutoff
    head = {"chain_id": meta["chain"], "height": str(latest), "time": indexed["blocks"]["nodes"][0]["timestamp"]}
    head_time = dt(head["time"])
    safe_end = head_time.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=2)
    end_time = dt(end) if end else safe_end
    if end_time > safe_end or end_time != end_time.replace(hour=0, minute=0, second=0, microsecond=0):
        raise ValueError(f"Use a whole UTC end date no later than {safe_end.date()}")
    service_rows = indexed_services(client, cutoff)
    services = [{"id": s["id"], "name": s.get("name") or s["id"],
                 "computeUnitsPerRelay": s.get("compute_units_per_relay")} for s in service_rows]
    # Explicit service list prevents top-by-settled from silently omitting services.
    query = '''query($ids:[String],$a:Datetime,$b:Datetime){getServiceUsageJson(
        services:$ids,rangeStart:$a,rangeEnd:$b,bucket:"day",topBySettled:200,
        byService:true,fillEmptyBuckets:false)}'''
    totals = defaultdict(lambda: {"estimatedComputeUnits": 0, "estimatedRelays": 0, "claims": 0, "coverage": []})
    for offset in range(0, len(services), 100):
        result = client.gql(query, ids=[s["id"] for s in services[offset:offset+100]],
                            a=iso(end_time-timedelta(days=7)), b=iso(end_time))
        usage = result["getServiceUsageJson"]
        rows = usage["data"]
        coverage = usage["range"]
        if coverage.get("gaps") or not coverage.get("covered_from") or dt(coverage["covered_from"]) > end_time-timedelta(days=7) or dt(coverage["covered_to"]) < end_time:
            raise ValueError("Indexer activity window has gaps or incomplete coverage")
        for row in rows:
            target_row = totals[row["service_id"]]
            for k in ("estimatedComputeUnits", "estimatedRelays", "claims"):
                source_k = {"estimatedComputeUnits": "estimated_compute_units", "estimatedRelays": "estimated_relays", "claims": "claims"}[k]
                if row[source_k] is None:
                    raise ValueError(f"Missing indexed activity field {k}")
                target_row[k] += integer(row[source_k], k)
            if not target_row["coverage"]:
                target_row["coverage"].append(coverage)
    for s in services:
        s.update(totals.get(s["id"], {"estimatedComputeUnits": None, "estimatedRelays": None, "claims": None, "coverage": []}))
    ranked = sorted((s for s in services if s["estimatedComputeUnits"]), key=lambda s: (-s["estimatedComputeUnits"], s["id"]))
    total = sum(s["estimatedComputeUnits"] for s in ranked)
    chosen, cumulative = [], 0
    for s in ranked:
        if len(chosen) >= max_services or (chosen and cumulative / total >= target):
            break
        chosen.append(s["id"])
        cumulative += s["estimatedComputeUnits"]
    if not chosen:
        raise ValueError("No indexed settled activity available for service selection")
    catalog = {"collectorVersion": VERSION, "fetchedAt": iso(utcnow()), "chainHead": head,
               "indexerMetadata": meta, "cutoff": cutoff, "endExclusive": iso(end_time),
               "activityWindow": {"start": iso(end_time-timedelta(days=7)), "endExclusive": iso(end_time)},
               "services": services, "selectedServices": chosen,
               "activityShare": cumulative/total, "targetShare": target, "maxServices": max_services,
               "selectionRule": "Top indexed settled estimated compute units; chosen before fleet earnings. Not all request traffic."}
    atomic_json(client.root / "catalog.json", catalog)
    print(json.dumps({"services": len(services), "chosen": chosen, "activityShare": cumulative/total,
                      "endExclusive": iso(end_time), "cutoff": cutoff}), flush=True)
    return catalog


def resolve_schedule(client, start, end, hours):
    times = []
    for day in range((dt(end)-dt(start)).days):
        times.extend(iso(dt(start)+timedelta(days=day, hours=h)) for h in hours)
    schedule = []
    # The indexer accepts at most 20 aliases per request.
    for offset in range(0, len(times), 20):
        part = times[offset:offset+20]
        fields = [f'b{i}:blocks(first:1,orderBy:ID_ASC,filter:{{timestamp:{{greaterThanOrEqualTo:{json.dumps(t)}}}}}){{nodes{{id timestamp}}}}' for i, t in enumerate(part)]
        result = client.gql("{" + " ".join(fields) + "}")
        for i, t in enumerate(part):
            rows = result[f"b{i}"]["nodes"]
            if len(rows) != 1 or not timedelta(0) <= dt(rows[0]["timestamp"])-dt(t) < timedelta(minutes=10):
                raise ValueError("Indexer cannot resolve sample time to a block within ten minutes")
            schedule.append({"height": int(rows[0]["id"]), "observedAt": iso(dt(rows[0]["timestamp"])), "scheduledAt": t})
    return schedule


def collect_point(client, point, service_ids, history, cutoff):
    """One sample height from the pocketdex session catalog.

    The sessions covering the height, their rosters and outcomes come from
    getSessionRostersJson. A stake or config change takes effect at the next
    session start, so eligible populations, owners and endpoints are the state
    staked before the start of the session covering the height (start - 1),
    which is the registry state the archive returned at the height. The authority
    for N is the session: its candidates must equal the population.
    """
    height = point["height"]
    shared = {r["key"]: str(param_at(history, "shared", r["key"], height)) for r in history if r["namespace"] == "shared"}
    start_time = iso(dt(point["observedAt"])-timedelta(hours=1))
    rows, before = [], None
    for _ in range(100):
        page = roster_page(client, start_time, iso(dt(point["observedAt"])+timedelta(hours=2)), service_ids, before=before)
        rows.extend(page)
        if len(page) < 1000:
            break
        before = (int(page[-1]["start_height"]), page[-1]["session_id"])
    covering = [r for r in rows if int(r["start_height"]) <= height <= int(r["end_height"])]
    if not rows or int(rows[-1]["start_height"]) >= height-int(shared["num_blocks_per_session"]):
        raise ValueError("Session catalog start range does not reach before the sample height")
    starts = {int(r["start_height"]) for r in covering}
    if len(starts) != 1:
        raise ValueError(f"Sessions covering height {height} do not share one start")
    start = starts.pop()
    statuses = None
    suppliers = staked_suppliers(client, start-1)
    def eligible_for(service_id):
        return {s["supplierId"] for s in suppliers if service_id in s["serviceIds"]}
    candidates = {(r["service_id"], int(r["candidates"])) for r in covering}
    if any(n != len(eligible_for(s)) for s, n in candidates):
        # An Unstaking supplier can still be selected until its unbonding ends.
        statuses = ["Staked", "Unstaking"]
        suppliers = staked_suppliers(client, start-1, statuses)
        if any(n != len(eligible_for(s)) for s, n in candidates):
            raise ValueError(f"Eligible population disagrees with the session candidates at height {height}")
    populations, sessions, claims = [], [], []
    for service_id in service_ids:
        eligible_ids = eligible_for(service_id)
        service_rows = sorted((r for r in covering if r["service_id"] == service_id), key=lambda r: r["application_id"])
        cap = param_at(history, "session", "num_suppliers_per_session", start)
        population = {"id": f"{service_id}:{height}", "serviceId": service_id, **point,
                      "totalEligible": len(eligible_ids), "selectionCap": cap,
                      "eligibleSupplierIds": sorted(eligible_ids)}
        populations.append(population)
        for r in service_rows:
            selected = r["member_ids"]
            if len(set(selected)) != len(selected) or not set(selected).issubset(eligible_ids):
                raise ValueError("Session roster duplicates or not in pinned eligible population")
            if len(selected) != min(cap, len(eligible_ids)) or int(r["roster_size"]) != len(selected):
                raise ValueError("Returned roster length disagrees with historical cap and population")
            sessions.append({"id": r["session_id"], "serviceId": service_id,
                             "applicationId": r["application_id"], "gatewayId": None,
                             "populationId": population["id"], "startedAt": point["observedAt"],
                             "scheduledAt": point["scheduledAt"], "sampleHeight": height,
                             "sessionStartHeight": int(r["start_height"]),
                             "sessionEndHeight": int(r["end_height"]),
                             "rosterSource": "session_catalog",
                             "selectedSupplierIds": selected, "selectedCount": len(selected), "rosterStatus": "complete"})
            claims.extend({**c, "numEstimatedRelays": None} for c in session_claims(r, {"cutoff": cutoff}, service_id))
    staked = {s["supplierId"]: s for s in suppliers if any(sid in s["serviceIds"] for sid in service_ids)}
    return {"point": point, "populations": populations, "sessions": sessions, "claims": claims,
            "stakedSuppliers": [{"id": sid, "owner": s["ownerId"], "services": sorted(set(s["serviceIds"]) & set(service_ids))}
                                for sid, s in sorted(staked.items())],
            "eligibilityStakeStatuses": statuses or ["Staked"], "sharedParams": shared, "sessionStartHeight": start,
            "claimedMembers": {r["session_id"]: int(r["claimed"]) for r in covering}}


def point_registry(part, configs, service_ids):
    """Registry at the sample height: owners and the endpoints declared before its session start."""
    start = part["sessionStartHeight"]
    raw = [{"operator_address": s["id"], "owner_address": s["owner"],
            "services": [{"service_id": sid, "endpoints": config_at(configs, s["id"], sid, start)} for sid in s["services"]]}
           for s in part["stakedSuppliers"]]
    part.update(registry=normalized_registry(raw, service_ids),
                registrySchemaVersion=REGISTRY_SCHEMA_VERSION)
    return part


def assemble(collected, claims, catalog, config, metrics):
    # Point files are streamed, not retained as 120 decoded registry dictionaries.
    collected.sort(key=lambda r: r['point']['height'] if isinstance(r,dict) else int(Path(r).name.split('.')[0]))
    suppliers, populations, sessions, endpoint_catalog = {}, [], {}, {}
    for item in collected:
        part=item if isinstance(item,dict) else read_json(item)
        point_date = part["point"]["observedAt"][:10]
        point_time = part["point"]["observedAt"]
        # Reuse one canonical address string across all populations and rosters.
        for pop in part['populations']:
            pop['eligibleSupplierIds']=[sys.intern(sid) for sid in pop['eligibleSupplierIds']]
        populations.extend(part["populations"])
        for r in part["registry"]:
            r['id']=sys.intern(r['id']);r['owner']=sys.intern(r['owner'])
            s = suppliers.setdefault(r["id"], {"id": r["id"], "name": short_address(r["id"]),
                    "fleetId": "", "groupId": "unverified", "groupName": "Infrastructure not attributed",
                    "serviceIds": set(), "endpointHosts": set(), "endpointIds": set(), "ownerHistory": [], "endpointHistory": []})
            s["serviceIds"].update(r["services"])
            s["endpointHosts"].update(r["hosts"])
            endpoint_ids = sorted(e["id"] for e in r.get("endpoints", []))
            for endpoint in r.get("endpoints", []):
                if endpoint["id"] in endpoint_catalog and endpoint_catalog[endpoint["id"]] != endpoint:
                    raise ValueError("Endpoint identity collision")
                endpoint_catalog.setdefault(endpoint["id"], endpoint)
            s["endpointIds"].update(endpoint_ids)
            if r.get("operatorAddressParts"):
                s["operatorAddressParts"] = r["operatorAddressParts"]
            if (not s["endpointHistory"] or s["endpointHistory"][-1]["hosts"] != r["hosts"]
                    or s["endpointHistory"][-1].get("endpointIds", []) != endpoint_ids):
                if s["endpointHistory"]:
                    s["endpointHistory"][-1]["end"] = point_time
                history = {"hosts": r["hosts"], "start": point_time, "end": None,
                           "firstObservedHeight": part["point"]["height"], "lastObservedHeight": part["point"]["height"]}
                if "endpoints" in r:
                    history["endpointIds"] = endpoint_ids
                s["endpointHistory"].append(history)
            else:
                s["endpointHistory"][-1]["lastObservedHeight"] = part["point"]["height"]
            if not s["ownerHistory"] or s["ownerHistory"][-1]["ownerId"] != r["owner"]:
                if s["ownerHistory"]:
                    s["ownerHistory"][-1]["end"] = point_time
                ownership = {"ownerId": r["owner"], "start": point_time, "end": None}
                if r.get("ownerAddressParts"):
                    ownership["addressParts"] = r["ownerAddressParts"]
                s["ownerHistory"].append(ownership)
        for s in part["sessions"]:
            s['selectedSupplierIds']=[sys.intern(sid) for sid in s['selectedSupplierIds']]
            sessions.setdefault(s["id"], s)
    by_session = defaultdict(list)
    claim_keys = set()
    for c in claims:
        key = (c["sessionId"], c["supplierId"])
        if key in claim_keys:
            raise ValueError("Duplicate settled claim for one Supplier in one session")
        claim_keys.add(key)
        session = sessions[c["sessionId"]]
        if c["supplierId"] not in session["selectedSupplierIds"] or c["applicationId"] != session["applicationId"]:
            raise ValueError("Claim not attributable to returned historical roster")
        by_session[c["sessionId"]].append(c)
    for sid, s in sessions.items():
        cs = by_session[sid]
        complete = bool(cs) and all(c["payoutVerified"] for c in cs)
        s.update(payoutStatus="complete" if complete else "missing",
                 totalPayoutPokt=sum(integer(c["payoutUpokt"]) for c in cs)/1e6 if complete else None,
                 supplierPayouts=[{"supplierId": c["supplierId"], "pokt": integer(c["payoutUpokt"])/1e6} for c in cs] if complete else [],
                 outcomeAvailableAt=max((iso(dt(c["block"]["timestamp"])) for c in cs), default=None),
                 # The session catalog has no per-session estimated relays.
                 settledClaimCount=len(cs), indexedEstimatedRelays=None)
    owners = defaultdict(list)
    for s in suppliers.values():
        s["serviceIds"] = sorted(s["serviceIds"])
        s["endpointHosts"] = sorted(s["endpointHosts"])
        s["endpointIds"] = sorted(s["endpointIds"])
        # Product scopes use historical owner membership, not this display grouping.
        owner = s["ownerHistory"][-1]["ownerId"]
        s["fleetId"] = "owner:" + owner
        for historical_owner in {h["ownerId"] for h in s["ownerHistory"]}:
            owners[historical_owner].append(s)
    fleets = []
    for owner, members in sorted(owners.items()):
        services = sorted({sid for s in members for sid in s["serviceIds"]})
        primary = next((sid for sid in catalog["selectedServices"] if sid in services), services[0])
        fleets.append({"id": "owner:"+owner, "ownerAddress": owner, "name": short_address(owner),
                       "primary": primary, "services": services, "exampleCount": len(members),
                       "identityKind": "owner_address", "tag": "Owner-address group",
                       "note": "Historical on-chain owner membership. Business identity not verified."})
    service_map = {s["id"]: s for s in catalog["services"]}
    live_services = [{"id": sid, "name": service_map[sid]["name"], "shortName": sid.upper()[:10],
                      "selectionCap": populations[-1]["selectionCap"]} for sid in config["services"]]
    indexed_total = sum(s.get('estimatedComputeUnits') or 0 for s in catalog['services'])
    activity_share = (sum(service_map[sid].get('estimatedComputeUnits') or 0 for sid in config['services'])/indexed_total
                      if indexed_total else catalog['activityShare'])
    selection_rule = (catalog['selectionRule'] if set(config['services'])==set(catalog['selectedServices'])
                      else 'Explicit service list; selected before collecting fleet earnings.')
    snapshot = {"schemaVersion": 1, "dataKind": "live", "snapshotId": "live-"+digest(config)[:16],
                "generatedAt": iso(utcnow()), "period": {"start": config["start"], "endExclusive": config["endExclusive"], "timezone": "UTC"},
                "description": "Live mainnet archive and indexer; sampled sessions. Owner-address groups are not verified businesses. No claims means unknown outcome, not verified zero.",
                "sampling": f"{len(config['hours'])} fixed UTC samples/day ({','.join(map(str,config['hours']))}); all historically eligible Applications per service; duplicate sessions removed. Indexed outcomes at block {config['cutoff']}.",
                "networkScopeValue": "live-sample", "networkNotice": "Sampled sessions for the collected services, with complete historical eligible populations. This is not all traffic or monthly total earnings.",
                "services": live_services, "fleets": fleets, "suppliers": list(suppliers.values()), "gateways": [],
                "endpointCatalog": sorted(endpoint_catalog.values(), key=lambda e:e["id"]),
                "applications": [{"id": a, "name": short_address(a), "gatewayId": None} for a in sorted({s['applicationId'] for s in sessions.values()})],
                "populations": populations, "sessions": sorted(sessions.values(), key=lambda s: (s['startedAt'], s['id'])),
                "liveSource": {"api": GRAPHQL, "graphql": GRAPHQL, "cutoff": config["cutoff"], "collectorVersion": VERSION,
                    "config": config, "registeredServiceCount": len(catalog["services"]), "activityShare": activity_share,
                    "catalogFetchedAt": catalog["fetchedAt"], "activityWindow": catalog["activityWindow"],
                    "serviceSelection": {"targetShare": catalog["targetShare"], "maxServices": catalog["maxServices"],
                        "targetReached": activity_share >= catalog["targetShare"], "rule": selection_rule},
                    "selectedServices": config["services"], "screeningSelectedServices": catalog["selectedServices"],
                    "endpointParsing": {"schemaVersion": REGISTRY_SCHEMA_VERSION, "processorVersion": VERSION,
                        "suffixListSource": "https://publicsuffix.org/list/public_suffix_list.dat", "suffixListSha256": PSL_SHA256,
                        "includesPrivateSuffixes": True, "endpointCount": len(endpoint_catalog),
                        "suffixListVersion": "2026-10-07_07-28-19_UTC",
                        "accountValidation": "Pocket Bech32 prefix, checksum, padding and 20-byte account payload; role comes from registry fields.",
                        "invalidEndpointCount": sum(e["parseStatus"] != "parsed" for e in endpoint_catalog.values()),
                        "identityRule": "Recorded service-specific endpoint association; business ownership, location and physical servers are not inferred."},
                    "serviceCatalog": catalog["services"], "collectionMetrics": metrics,
                    "coverage": {"samplePoints": len(collected), "sessions": len(sessions), "settledClaims": len(claims),
                        "comparableSessions": sum(s['payoutStatus']=='complete' for s in sessions.values()),
                        "unverifiedPayoutClaims": sum(not c['payoutVerified'] for c in claims)}}}
    snapshot["liveSource"]["leaderboards"] = build_leaderboards(snapshot)
    snapshot["liveSource"]["domainLeaderboards"] = build_leaderboards(snapshot, "domain")
    return snapshot


def build_leaderboards(snapshot, grouping="owner"):
    """Precompute fair within-service comparisons; never rank sparse/partial rows."""
    def quantile(values, p):
        x = (len(values)-1)*p
        lo = int(x)
        hi = min(lo+1, len(values)-1)
        return values[lo] + (values[hi]-values[lo])*(x-lo)
    suppliers = {s['id']: s for s in snapshot['suppliers']}
    endpoints = {e['id']: e for e in snapshot.get('endpointCatalog', [])}
    populations = {p['id']: p for p in snapshot['populations']}
    owners_by_population = {}
    for pid, pop in populations.items():
        at = pop['observedAt']
        ownership = {sid: next((h['ownerId'] for h in suppliers[sid]['ownerHistory'] if h['start']<=at and (not h['end'] or at<h['end'])), None) for sid in pop['eligibleSupplierIds']}
        if any(owner is None for owner in ownership.values()):
            raise ValueError('Missing owner at historical observation')
        memberships = {}
        counts, group_owners = defaultdict(int), defaultdict(set)
        for sid, owner in ownership.items():
            if grouping == "owner":
                groups = {owner}
            else:
                history = next((h for h in suppliers[sid]['endpointHistory'] if h['start']<=at and (not h['end'] or at<h['end'])), {})
                groups = {endpoints[eid]['registrableDomain'] for eid in history.get('endpointIds', [])
                          if endpoints[eid]['serviceId']==pop['serviceId'] and endpoints[eid].get('registrableDomain')}
            memberships[sid] = groups
            for group in groups:
                counts[group] += 1
                group_owners[group].add(owner)
        owners_by_population[pid] = (memberships, counts, group_owners)
    boards = {}
    for days in (7, 14, 30):
        lower = max(dt(snapshot['period']['start']), dt(snapshot['period']['endExclusive'])-timedelta(days=days))
        board = {}
        for service in snapshot['services']:
            sessions = [s for s in snapshot['sessions'] if s['serviceId']==service['id'] and dt(s['startedAt'])>=lower]
            owners = {o for s in sessions for o in owners_by_population[s['populationId']][1]}
            stats = {o: {'actualPokt': 0, 'equalSharePokt': 0, 'selectedPositions': 0, 'presentSessions': 0, 'daily': defaultdict(lambda:[0.0,0.0]), 'positiveSessions': 0} for o in owners}
            comparable = sum(s['payoutStatus']=='complete' for s in sessions)
            for s in sessions:
                ownership, counts, _ = owners_by_population[s['populationId']]
                selected = defaultdict(int)
                for sid in s['selectedSupplierIds']:
                    for group in ownership[sid]:
                        selected[group] += 1
                for owner, x in selected.items():
                    stats[owner]['selectedPositions'] += x
                    stats[owner]['presentSessions'] += 1
                if s['payoutStatus']!='complete':
                    continue
                for owner_stats in stats.values():
                    owner_stats['daily'][s['startedAt'][:10]]  # Retain days with zero opportunity.
                actual = defaultdict(float)
                for p in s['supplierPayouts']:
                    for group in ownership[p['supplierId']]:
                        actual[group] += p['pokt']
                for owner, x in selected.items():
                    ref = s['totalPayoutPokt']*x/s['selectedCount']
                    r = stats[owner]
                    r['actualPokt'] += actual[owner]
                    r['equalSharePokt'] += ref
                    r['daily'][s['startedAt'][:10]][0] += actual[owner]
                    r['daily'][s['startedAt'][:10]][1] += ref
                    r['positiveSessions'] += ref>0
            latest = next((p for p in reversed(snapshot['populations']) if p['serviceId']==service['id']), None)
            latest_counts = owners_by_population[latest['id']][1] if latest else {}
            rows = []
            for owner, r in stats.items():
                daily = list(r.pop('daily').values())
                informative_days = sum(b>0 for a,b in daily)
                ref = r['equalSharePokt']
                ratio = r['actualPokt']/ref if ref>0 else None
                coverage = comparable/len(sessions) if sessions else 0
                largest = max((b/ref for a,b in daily), default=0) if ref else None
                availability = 'unavailable' if ratio is None else 'partial' if coverage<.9 else 'limited' if informative_days<7 or r['positiveSessions']<24 or largest>.4 else 'available'
                interval = None
                if informative_days>=7 and r['positiveSessions']>=24:
                    rng = random.Random(int(digest([snapshot['snapshotId'],service['id'],days,owner])[:16],16))
                    draws = []
                    for _ in range(2000):
                        sample = [daily[rng.randrange(len(daily))] for _ in daily]
                        den = sum(b for a,b in sample)
                        if den>0:
                            draws.append(sum(a for a,b in sample)/den)
                    if len(draws)>=1800:
                        draws.sort()
                        interval = [quantile(draws,.025),quantile(draws,.975)]
                    elif availability=='available':
                        availability='limited'
                identity = ({'ownerAddress': owner, 'fleetId':'owner:'+owner, 'name':short_address(owner),
                             'scope':{'type':'fleet','value':'owner:'+owner}} if grouping=='owner' else
                            {'domain':owner, 'name':owner, 'scope':{'type':'domain','value':owner},
                             'ownerCount':len(owners_by_population[latest['id']][2].get(owner,set())) if latest else 0})
                rows.append({**r, **identity, 'grouping':grouping,
                             'eligibleSuppliers':latest_counts.get(owner,0), 'ratio':ratio, 'differencePercent':(ratio-1)*100 if ratio is not None else None,
                             'intervalRatio':interval, 'availability':availability, 'informativeDays':informative_days,
                             'coverage':coverage, 'recordedSessions':len(sessions), 'comparableSessions':comparable,
                             'largestDayShare':largest, 'presenceFraction':r['presentSessions']/len(sessions) if sessions else None})
            board[service['id']] = sorted(rows,key=lambda r:(r['availability']!='available',-r['actualPokt'],r.get('domain',r.get('ownerAddress'))))
        boards[str(days)] = board
    return boards


def short_address(address):
    return address[:10] + "…" + address[-6:]


def collect(client, catalog, days=30, service_ids=None, resume=None, hours=HOURS):
    started = time.perf_counter()
    if resume:
        config = read_json(resume)["config"]
        if config["collectorVersion"] not in RESUMABLE_VERSIONS:
            raise ValueError("Resume collector version mismatch")
    else:
        end = dt(catalog["endExclusive"])
        service_ids = service_ids or catalog["selectedServices"]
        available_ids = {s["id"] for s in catalog["services"]}
        if not set(service_ids).issubset(available_ids):
            raise ValueError("Unknown service ID")
        config = {"collectorVersion": VERSION, "start": iso(end-timedelta(days=days)), "endExclusive": iso(end),
                  "services": sorted(set(service_ids)), "hours": hours, "applicationPolicy": "all_historical",
                  "rosterMode":"session_catalog",
                  "cutoff": catalog["cutoff"], "settlementBufferDays": 2}
    run_dir = client.root / "runs" / digest(config)[:16]
    run_dir.mkdir(parents=True, exist_ok=True)
    if resume and (run_dir/'catalog.json').exists():
        catalog=read_json(run_dir/'catalog.json')
    if catalog['cutoff']!=config['cutoff']:
        raise ValueError('Resume requires the original catalogue and fixed indexer cutoff')
    atomic_json(run_dir/'catalog.json',catalog)
    state = {"config": config, "status": "collecting", "startedAt": iso(utcnow())}
    atomic_json(run_dir / "run.json", state)
    try:
        schedule = resolve_schedule(client, config["start"], config["endExclusive"], config["hours"])
        if any(p['height']<ROSTER_ERA_HEIGHT for p in schedule):
            raise ValueError("Collection is restricted to the catalog's session rosters")
        history=client.gql(PARAMS_QUERY,keys=None)['getParamHistoryList']
        print(f"Collecting {len(schedule)} shared historical registries, services {config['services']}, all historical Applications.", flush=True)
        # Sequential: one sample height at a time against the shared public API.
        collected=[]
        for p in schedule:
            path = run_dir / "points" / (str(p["height"])+".json.gz")
            if not path.exists():
                atomic_json(path, collect_point(client, p, config["services"], history, config["cutoff"]))
            collected.append(path)
        # Point files are streamed: one decoded registry at a time. Only points still
        # without a registry need the members' config history.
        pairs=set()
        for path in collected:
            part=read_json(path)
            if part.get("registrySchemaVersion") != REGISTRY_SCHEMA_VERSION:
                pairs.update((s['id'],sid) for s in part['stakedSuppliers'] for sid in s['services'])
        configs=supplier_configs(client,sorted(pairs)) if pairs else {}
        sessions={};claims=[]
        for path in collected:
            part=read_json(path)
            if part.get("registrySchemaVersion") != REGISTRY_SCHEMA_VERSION:
                atomic_json(path, point_registry(part, configs, config["services"]))
            shared=part['sharedParams']
            # Conservative upper guard on timing offsets, in addition to the UTC
            # two-day exclusion. Uses the historical effective settings.
            lag=sum(int(v) for k,v in shared.items() if k.endswith('_offset_blocks'))+2*int(shared['num_blocks_per_session'])
            if any(s['sessionEndHeight']+lag>=config['cutoff'] for s in part['sessions']):
                raise ValueError('An observed session has not passed the conservative historical settlement guard')
            for session in part['sessions']:
                if session['id'] not in sessions:
                    sessions[session['id']]=session
                    claims.extend(c for c in part['claims'] if c['sessionId']==session['id'])
        times=block_times(client,[c['blockId'] for c in claims],config,window=False)
        for c in claims:
            c['block']={'timestamp':times[int(c['blockId'])]}
        print(f"Settled payouts for {len(sessions)} unique sessions from the session catalog.", flush=True)
        metrics = {"secondsThisInvocation": round(time.perf_counter()-started, 2), "httpAttemptsThisInvocation": len(client.metrics),
                   "wireBytesThisInvocation": sum(m['bytes'] for m in client.metrics), "sourceCacheRoot": "responses/"}
        snapshot = assemble(collected, claims, catalog, config, metrics)
        snapshot['liveSource']['rosterVerification']={'source':'getSessionRostersJson','rostersFromHeight':ROSTER_ERA_HEIGHT,
                    'eligibilityStakeStatuses':sorted({s for path in collected for s in read_json(path)['eligibilityStakeStatuses']}),
                    'rule':'Every eligible population equals the candidates of the sessions covering its height.'}
        atomic_json(run_dir / "snapshot.json.gz", snapshot)
        # Same evidence, compact wire representation for a fast static product.
        supplier_index={s['id']:i for i,s in enumerate(snapshot['suppliers'])}
        product={**snapshot,'populations':[],'wireCodec':'supplier-indices-v1'}
        for p in snapshot['populations']:
            product['populations'].append({**{k:v for k,v in p.items() if k!='eligibleSupplierIds'},
                                          'eligibleSupplierIndices':[supplier_index[sid] for sid in p['eligibleSupplierIds']]})
        atomic_json(run_dir/'product-snapshot.json.gz',product)
        atomic_json(run_dir / "claims.json.gz", claims)
        state.update(status="complete", completedAt=iso(utcnow()), metrics=metrics, snapshotPath=str(run_dir/"snapshot.json.gz"))
        atomic_json(run_dir / "run.json", state)
        atomic_json(client.root / "latest.json", state)
        print(json.dumps({"snapshot": state["snapshotPath"], "coverage": snapshot['liveSource']['coverage'], "metrics": metrics}), flush=True)
        return snapshot
    except BaseException as e:
        state.update(status="failed", error=str(e), failedAt=iso(utcnow()))
        atomic_json(run_dir / "run.json", state)
        print(f"Collection incomplete. Cached work is retained. Resume: --resume {run_dir/'run.json'}", flush=True)
        raise


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["discover", "collect"])
    p.add_argument("--out", type=Path, default=Path("pokt-live-cache"))
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--services", help="Comma-separated explicit service IDs; overrides activity-based selection")
    p.add_argument("--fixed-eight", action="store_true", help="Keep the eight reviewed services fixed rather than reselecting by activity")
    p.add_argument("--max-services", type=int, default=8)
    p.add_argument("--activity-share", type=float, default=.95)
    p.add_argument("--end", help="Whole UTC exclusive end date; default excludes two recent UTC days")
    p.add_argument("--workers", type=int, default=2, choices=range(1, 5),help='Two workers limit registry decode memory; up to four when resources permit')
    p.add_argument("--resume", type=Path, help="Exact previous run.json; retains cutoff and sampling frame")
    p.add_argument('--reuse-catalog',action='store_true',help='Start a new run with the saved screening window and cutoff; new collections refresh the catalogue by default')
    args = p.parse_args()
    if not 1 <= args.days <= 90 or not 1 <= args.max_services <= 50 or not 0 < args.activity_share <= 1:
        p.error("Use days 1–90, max-services 1–50, activity-share (0,1]")
    if args.fixed_eight and args.services:
        p.error("Choose --fixed-eight or --services")
    client = Client(args.out, args.workers)
    catalog_path = args.out / "catalog.json"
    if args.resume:
        frozen=args.resume.parent/'catalog.json'
        if frozen.exists():
            catalog_path=frozen
        if not catalog_path.exists():
            p.error('Resume requires the saved original catalogue; do not refresh its cutoff')
    if args.command == "discover" or not catalog_path.exists() or (not args.resume and not args.reuse_catalog):
        catalog = discover(client, args.end, args.max_services, args.activity_share)
    else:
        catalog = read_json(catalog_path)
    if args.command == "collect":
        services = FIXED_SERVICES if args.fixed_eight else [s.strip() for s in args.services.split(",")] if args.services else None
        if args.resume and services and set(services) != set(read_json(args.resume)["config"]["services"]):
            p.error("Resume service list differs from the frozen run")
        collect(client, catalog, args.days, services, args.resume)


if __name__ == "__main__":
    main()
