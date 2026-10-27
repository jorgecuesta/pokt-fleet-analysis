"""Read-only access to the pocketdex session catalog (data.pocket.network/graphql).

Python 3.10+, standard library only. Both collectors read rosters, outcomes,
supplier service configs, stake state and governance parameters through these
functions, with the caller's audited caching Client. Numbers arrive as strings.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

ROSTERS_QUERY = '''query($a:Datetime,$b:Datetime,$services:[String],$ids:[String],$apps:[String],$h:BigInt,$sid:String){
 getSessionRostersJson(rangeStart:$a,rangeEnd:$b,services:$services,sessionIds:$ids,applications:$apps,rowLimit:1000,
 beforeHeight:$h,beforeSessionId:$sid)}'''
CONFIG_QUERY = '''query($ids:[String],$services:[String]){getSuppliersConfigHistoryJson(suppliers:$ids,services:$services)}'''
NETWORK_QUERY = '''query($a:Datetime,$b:Datetime,$services:[String]){getNetworkSessionsJson(
 rangeStart:$a,rangeEnd:$b,services:$services,byService:true)}'''
PARAMS_QUERY = '''query($keys:[String]){getParamHistoryList(keys:$keys){namespace key height activeAt value}}'''
STAKED_QUERY = '''query($h:BigInt,$after:String,$statuses:[String]){getStakedSuppliersList(
 atHeight:$h,afterSupplierId:$after,stakeStatuses:$statuses,rowLimit:1000){supplierId ownerId serviceIds height}}'''
BLOCKS_QUERY = '''query($filter:BlockFilter!){blocks(first:200,filter:$filter){
 totalCount pageInfo{hasNextPage} nodes{id timestamp}}}'''
PAGE_SIZE = 1000
# The catalog computes rosters as poktroll's session hydrator does from v0.1.33 on.
ROSTER_ERA_HEIGHT = 703870
# Catalog member states with a settled claim (pocketdex sessionRosters: paid > 0, settled_zero = 0).
SETTLED_STATES = ("paid", "settled_zero")
# poktroll proto/pocket/shared/service.proto RPCType; the catalog returns the enum number.
RPC_TYPES = {"0": "UNKNOWN_RPC", "1": "GRPC", "2": "WEBSOCKET", "3": "JSON_RPC", "4": "REST", "5": "COMET_BFT"}


def nat(value, label):
    if isinstance(value, bool) or not str(value).isdigit():
        raise ValueError(f"{label} must be a nonnegative integer, got {value!r}")
    return int(value)


def dt(value):
    # dt and iso repeat pokt_live_collector's, so that collector can import this module.
    d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)


def iso(t):
    return t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def check_range(result, start, end):
    """Every catalog answer must cover the asked starts, with no settlement gap."""
    coverage = result["range"]
    if (coverage.get("gaps") or not coverage.get("covered_from") or not coverage.get("covered_to")
            or dt(coverage["covered_from"]) > dt(start) or dt(coverage["covered_to"]) < dt(end)):
        raise ValueError("Session catalog does not cover the window or reports a settlement gap")
    return result["data"]


def roster_page(client, start, end, services=None, session_ids=None, before=None, applications=None):
    before = before or (None, None)
    result = client.gql(ROSTERS_QUERY, a=start, b=end, services=services, ids=session_ids, apps=applications,
                        h=None if before[0] is None else str(before[0]), sid=before[1])["getSessionRostersJson"]
    rows = check_range(result, start, end) if session_ids is None else result["data"]
    if not isinstance(rows, list) or len(rows) > PAGE_SIZE:
        raise ValueError("Invalid or unordered session catalog page")
    keys = [(nat(r["start_height"], "start height"), r["session_id"]) for r in rows]
    if any(b >= a for a, b in zip(keys, keys[1:])) or (before[0] is not None and keys and keys[0] >= (before[0], before[1])):
        raise ValueError("Invalid or unordered session catalog page")
    return rows


def session_claims(row, config, service):
    """One settled claim per member in a settled state, as the indexed claim records were."""
    if row["service_id"] != service or not all(isinstance(row.get(k), str) and row[k] for k in ("session_id", "application_id")):
        raise ValueError("Session identity is missing or belongs to another service")
    end, size = nat(row["end_height"], "session end"), nat(row["roster_size"], "roster size")
    members = list(zip(row["member_ids"], row["member_states"], row["member_paid_upokt"], row["member_owner_ids"]))
    if size != len(members) or len(set(row["member_ids"])) != size or not size:
        raise ValueError("Empty, duplicate or inconsistent catalog roster")
    if row["money_missing"] or "unresolved" in row["member_states"]:
        raise ValueError("Session money is not indexed yet; keep this run for investigation")
    claims = [m for m in members if m[1] in SETTLED_STATES]
    if not claims or row["phase"] != "settled":
        return []
    block = nat(row["settled_height"], "settlement block")
    if not end < block <= config["cutoff"]:
        return []
    return [{"id": f"{row['session_id']}:{supplier}", "supplierId": supplier, "serviceId": service,
             "applicationId": row["application_id"], "sessionId": row["session_id"], "sessionEndHeight": str(end),
             "blockId": str(block), "payoutUpokt": str(nat(paid, "payout")), "payoutVerified": True}
            for supplier, state, paid, _ in claims]


def settled_seats(rows, start, end):
    """Members with a settled claim in the sessions that started in [start, end)."""
    return sum(state in SETTLED_STATES for r in rows if dt(start) <= dt(r["start_time"]) < dt(end)
               for state in r["member_states"])


def network_settled_seats(client, start, end, service):
    """The catalog's own total of settled seats for one service's sessions started in [start, end)."""
    result = client.gql(NETWORK_QUERY, a=start, b=end, services=[service])["getNetworkSessionsJson"]
    rows = check_range(result, start, end)
    if any(r["service_id"] != service or nat(r["active"], "active") or nat(r["unresolved"], "unresolved") for r in rows):
        raise ValueError("Network session total belongs to another service or is not settled")
    return sum(nat(r["paid"], "paid seats")+nat(r["settled_zero"], "settled-zero seats") for r in rows)


def is_statement_timeout(exc):
    message = str(exc)
    return (message.startswith("GraphQL errors:") and "57014" in message
            and "canceling statement due to statement timeout" in message)


def param_at(history, namespace, key, height):
    rows = [r for r in history if r["namespace"] == namespace and r["key"] == key and nat(r["activeAt"], "param height") <= height]
    if not rows:
        raise ValueError(f"No {namespace}.{key} in effect at {height}")
    return nat(max(rows, key=lambda r: nat(r["activeAt"], "param height"))["value"], key)


def supplier_configs(client, members, progress=print):
    """Service config history of each (supplier, service) pair, 200 suppliers per call.

    One service per call: eight services at once can exceed the indexer's statement timeout.
    """
    configs = defaultdict(list)
    by_service = defaultdict(set)
    for supplier, service in members:
        by_service[service].add(supplier)
    def fetch(ids, service, progress):
        try:
            return client.gql(CONFIG_QUERY, ids=ids, services=[service])["getSuppliersConfigHistoryJson"]
        except ValueError as exc:
            if not is_statement_timeout(exc) or len(ids) < 2:
                raise
            # Only the observed PostgreSQL timeout is retried, once, as two halves.
            progress(f"Indexer statement timeout: config history of {len(ids)} {service} suppliers retried as two halves.")
            half = len(ids)//2
            return [row for part in (ids[:half], ids[half:])
                    for row in client.gql(CONFIG_QUERY, ids=part, services=[service])["getSuppliersConfigHistoryJson"]]
    for service, suppliers in sorted(by_service.items()):
        ids = sorted(suppliers)
        for offset in range(0, len(ids), 200):
            for row in fetch(ids[offset:offset+200], service, progress):
                if row["service_id"] != service or row["supplier_id"] not in suppliers:
                    raise ValueError("Config history returned another supplier or service")
                configs[(row["supplier_id"], service)].append(row)
    return configs


def config_at(configs, supplier, service, start):
    """Endpoints the session was served from. A config declared at height d takes
    effect at the next session start, so the one declared at start-1 applies."""
    rows = [r for r in configs.get((supplier, service), []) if nat(r["first_height"], "config start") < start
            and (r["last_height"] is None or start <= nat(r["last_height"], "config end")+1)]
    if len(rows) != 1:
        raise ValueError("A selected Supplier lacks its service-specific historical configuration")
    return [{"url": e["url"], "rpc_type": RPC_TYPES[str(e["rpcType"])]} for e in rows[0]["endpoints"]]


def staked_suppliers(client, height, statuses=None):
    """Suppliers in the given stake statuses at one height, with their owner and service ids."""
    rows, after = [], None
    for _ in range(1000):
        page = client.gql(STAKED_QUERY, h=str(height), after=after, statuses=statuses)["getStakedSuppliersList"]
        if any(int(r["height"]) != height for r in page) or (rows and page and page[0]["supplierId"] <= rows[-1]["supplierId"]):
            raise ValueError("Staked supplier page read another height or is unordered")
        rows.extend(page)
        if len(page) < 1000:
            return rows
        after = page[-1]["supplierId"]
    raise ValueError("Staked supplier pagination failed to finish")


def block_times(client, heights, config, window=True):
    times={}
    values=sorted({int(h) for h in heights})
    for offset in range(0,len(values),200):
        part=values[offset:offset+200]
        conn=client.gql(BLOCKS_QUERY,filter={"id":{"in":[str(h) for h in part]}})["blocks"]
        rows=conn["nodes"]
        if nat(conn["totalCount"],"block count")!=len(part) or len(rows)!=len(part) or conn["pageInfo"]["hasNextPage"] is not False:
            raise ValueError("Historical block timestamp batch is incomplete")
        for row in rows:
            height=nat(row["id"],"block height")
            at=iso(dt(row["timestamp"]))
            if height not in part or height in times or (window and not dt(config["start"])<=dt(at)<dt(config["endExclusive"])):
                raise ValueError("Historical block timestamp is repeated or out of scope")
            times[height]=at
    return times
