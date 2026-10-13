"""Shared V4 methodology and data pipeline for notebook and Streamlit.

Statistical functions retain V4 definitions. V5 changes are documented in CHANGELOG.md.
Network access is closed by default; only the explicit build stage opens it.
"""
NETWORK_ENABLED = False
RAW_RESPONSE_DIR = None
HTTP_JOURNAL_PATH = None
import base64
import gzip
import hashlib
import json
import lzma
import math
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from IPython.display import display, Markdown, HTML

API = "https://sauron-api.infra.pocket.network"
GRAPHQL = "https://data.pocket.network/graphql"
PAYOUT_REASONS = [
    "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_RD",
    "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION",
]
plt.rcParams.update({
    "figure.figsize": (8.4, 3.5), "figure.dpi": 120, "font.size": 10,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.titleweight": "bold",
})


def utc(value):
    return pd.to_datetime(value, utc=True).to_pydatetime(warn=False)

HTTP_METRICS = []


def request_json(url, body=None, height=None):
    if not NETWORK_ENABLED:
        raise RuntimeError("Exploration is offline. Use build_dataset deliberately to fetch data.")
    headers = {"Content-Type": "application/json", "Accept-Encoding": "gzip",
               "User-Agent": "pokt-session-exposure-study"}
    if height is not None:
        headers["x-cosmos-block-height"] = str(height)
    data = None if body is None else json.dumps(body).encode()
    for attempt in range(3):
        started = time.perf_counter()
        byte_count, success = 0, False
        try:
            with urlopen(Request(url, data=data, headers=headers), timeout=75) as response:
                raw = response.read()
                byte_count = len(raw)
                served_height = response.headers.get("x-cosmos-block-height")
                if response.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
            if height is not None and served_height != str(height):
                raise ValueError("Archive did not confirm the requested height.")
            result = json.loads(raw)
            if RAW_RESPONSE_DIR is not None:
                # Preserve the full response before downstream normalization mutates it.
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
                key = hashlib.sha256(json.dumps([url, body, height], sort_keys=True).encode()).hexdigest()[:16]
                target = RAW_RESPONSE_DIR / (stamp+"_"+key+".json.gz")
                temporary = target.with_suffix(target.suffix+".tmp")
                with gzip.open(temporary, "wt") as saved:
                    json.dump({"url": url, "body": body, "requested_height": height,
                               "served_height": served_height, "fetched_at": stamp,
                               "received_bytes": byte_count, "response": result}, saved, separators=(",", ":"))
                temporary.replace(target)
            success = True
            return result
        except (ValueError, KeyError):
            raise
        except HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504):
                detail = exc.read().decode(errors="replace")
                raise RuntimeError(f"HTTP {exc.code}: {detail[:500]}") from exc
            if attempt == 2:
                raise
        except Exception:
            if attempt == 2:
                raise
        finally:
            metric = {"url": url.split("?")[0], "seconds": time.perf_counter()-started,
                      "bytes": byte_count, "success": success}
            HTTP_METRICS.append(metric)
            if HTTP_JOURNAL_PATH is not None:
                with _JOURNAL_LOCK:
                    with HTTP_JOURNAL_PATH.open("a") as journal:
                        journal.write(json.dumps({**metric, "height": height,
                            "finished_at": datetime.now(timezone.utc).isoformat()})+"\n")
        time.sleep(1 + attempt)

def rest(path, height=None, **params):
    return request_json(API + path + ("?" + urlencode(params) if params else ""), height=height)

def graphql(query, **variables):
    result = request_json(GRAPHQL, {"query": query, "variables": variables})
    if result.get("errors") or result.get("data") is None:
        raise RuntimeError(f"Indexer query failed: {result.get('errors')}")
    return result["data"]

def fetch_population(service, height):
    records, cursor, seen = {}, None, set()
    for page in range(100):
        params = {"service_id": service, "dehydrated": "true", "pagination.limit": 10000}
        if cursor:
            params["pagination.key"] = cursor
        result = rest("/pokt-network/poktroll/supplier/supplier", height, **params)
        for row in result["supplier"]:
            address, owner = row["operator_address"], row["owner_address"]
            if not address or not owner:
                raise ValueError("Incomplete historical Supplier identity.")
            if address in records and records[address] != owner:
                raise ValueError("Conflicting owner in historical registry.")
            records[address] = owner
        cursor = result.get("pagination", {}).get("next_key")
        if not cursor:
            break
        if cursor in seen:
            raise ValueError("Repeated registry pagination cursor.")
        seen.add(cursor)
    else:
        raise RuntimeError("Registry pagination did not finish.")
    if not records:
        raise ValueError(f"No eligible Suppliers for {service} at {height}.")
    return {"height": height, "rows": sorted(records.items()), "pages": page+1}

def fetch_session(service, height, application):
    session = rest("/pokt-network/poktroll/session/get_session", height,
                   application_address=application, service_id=service,
                   block_height=height)["session"]
    header = session["header"]
    assert header["service_id"] == service and header["application_address"] == application
    assert int(header["session_start_block_height"]) <= height <= int(header["session_end_block_height"])
    return {"height": height, "application": application,
            "session_id": session["session_id"],
            "start_height": int(header["session_start_block_height"]),
            "end_height": int(header["session_end_block_height"]),
            "selected": sorted((r["operator_address"], r["owner_address"])
                               for r in session["suppliers"])}

def fetch_claims(service, session_ids, indexer_cutoff):
    """Complete pagination; gross Supplier distributions across all rev-share recipients."""
    query = """query($filter:EventClaimSettledFilter!, $after:Cursor,
                       $payout:ModToAcctTransferFilter!) {
      eventClaimSettleds(first:500, after:$after, orderBy:ID_ASC, filter:$filter) {
        totalCount pageInfo {hasNextPage endCursor}
        nodes { id supplierId serviceId applicationId sessionId sessionEndHeight blockId
          numEstimatedRelays numEstimatedComputedUnits numRelays numClaimedComputedUnits settledAmount settledDenom mintRatio mintedAmount mintedDenom overservicingLossAmount deflationLossAmount
          modToAcctTransfers(filter:$payout) {totalCount aggregates {sum {amount}}}
        }
      }
    }"""
    filters = {"serviceId": {"equalTo": service}, "sessionId": {"in": session_ids},
               "blockId": {"lessThanOrEqualTo": str(indexer_cutoff)}}
    payout = {"denom": {"equalTo": "upokt"}, "opReason": {"in": PAYOUT_REASONS}}
    rows, cursor, seen, expected_count = {}, None, set(), None
    for _ in range(100):
        result = graphql(query, filter=filters, payout=payout, after=cursor)["eventClaimSettleds"]
        if expected_count is None:
            expected_count = result["totalCount"]
        if result["totalCount"] != expected_count:
            raise ValueError("Indexer changed during pagination; retry collection.")
        for row in result["nodes"]:
            if row["id"] in rows:
                raise ValueError("Duplicate settlement across pages.")
            aggregate = row.pop("modToAcctTransfers")
            amount = aggregate["aggregates"]["sum"]["amount"]
            if amount is None and aggregate["totalCount"]:
                raise ValueError("Missing payout amount.")
            value = Decimal(amount or "0")
            if not value.is_finite() or value < 0:
                raise ValueError("Invalid payout amount.")
            row["payout_upokt"] = str(value)
            row["transfer_count"] = aggregate["totalCount"]
            rows[row["id"]] = row
        print(f"Settled claims: {len(rows):,}/{expected_count:,}", flush=True)
        if not result["pageInfo"]["hasNextPage"]:
            if len(rows) != expected_count:
                raise ValueError("Incomplete settlement pagination.")
            return list(rows.values())
        cursor = result["pageInfo"]["endCursor"]
        if not cursor or cursor in seen:
            raise ValueError("Invalid settlement cursor.")
        seen.add(cursor)
    raise RuntimeError("Settlement pagination did not finish.")

# ---- Original statistical definitions ----
def distribution(N, n, cap=50):
    """Exact hypergeometric PMF, including every possible x from 0 to K."""
    if any(not isinstance(v, (int, np.integer)) for v in (N, n, cap)):
        raise ValueError("Supplier counts must be integers.")
    if not (N >= 0 and 0 <= n <= N and cap >= 1):
        raise ValueError("Require 0 <= n <= N and a positive session cap.")
    K = min(N, cap)
    denominator = math.comb(N, K)
    return np.array([
        math.comb(n, x) * math.comb(N-n, K-x) / denominator
        if x <= n and 0 <= K-x <= N-n else 0.
        for x in range(K+1)
    ])

def exposure_stats(N, n, cap):
    p = distribution(N, n, cap)
    x = np.arange(len(p))
    mean = float(x @ p)
    variance = float(((x-mean)**2) @ p)
    present = float(p[1:].sum())
    return {"N": N, "n": n, "K": len(p)-1, "P(X≥1)": present,
            "E[X]": mean, "Variance": variance, "SD": math.sqrt(variance),
            "P(X≥2)": float(p[2:].sum()), "P(X≥3)": float(p[3:].sum()),
            "P(X≥5)": float(p[5:].sum()),
            "E[X | X≥1]": mean/present if present else np.nan}

def minimum_fleet(others, target, cap):
    """Others stay fixed; adding our Suppliers also increases the total."""
    lo, hi = 0, 1
    while distribution(others+hi, hi, cap)[1:].sum() < target:
        hi *= 2
    while hi-lo > 1:
        mid = (lo+hi)//2
        if distribution(others+mid, mid, cap)[1:].sum() >= target:
            hi = mid
        else:
            lo = mid
    return hi

def make_frames(study):
    claims = pd.DataFrame(study["claims"], columns=CLAIM_COLUMNS)
    sessions = pd.DataFrame(study["sessions"]).sort_values(["height", "application"]).reset_index(drop=True)
    sessions["date"] = pd.to_datetime(sessions.timestamp, utc=True).dt.strftime("%Y-%m-%d")
    sessions["period"] = np.where(pd.to_datetime(sessions.timestamp, utc=True) < pd.Timestamp(study["split"]),
                                 "Earlier", "Later")
    by_id = {s["session_id"]: s for s in study["sessions"]}
    totals = {}
    for row in study["claims"]:
        sid = row["sessionId"]
        value = Decimal(row["payout_upokt"])/Decimal(1_000_000)
        t = totals.setdefault(sid, {"value": Decimal(0), "actual": Decimal(0), "claims": 0,
                                   "relays": Decimal(0), "cus": Decimal(0), "relay_known": True, "cu_known": True})
        t["value"] += value
        if row["supplierId"] in by_id[sid]["fleet_selected"]:
            t["actual"] += value
        t["claims"] += 1
        for source, target, known in [("numEstimatedRelays", "relays", "relay_known"),
                                       ("numEstimatedComputedUnits", "cus", "cu_known")]:
            if row[source] is None:
                t[known] = False
            else:
                t[target] += Decimal(row[source])
    for key in ["value", "actual", "claims"]:
        sessions[key] = sessions.session_id.map(lambda sid: float(totals.get(sid, {}).get(key, 0)))
    for key, known in [("relays", "relay_known"), ("cus", "cu_known")]:
        sessions[key] = sessions.session_id.map(
            lambda sid: float(totals[sid][key]) if sid in totals and totals[sid][known] else np.nan)
    sessions["draw_share"] = sessions.X/sessions.K
    sessions["eligible_share"] = sessions.n/sessions.N
    sessions["expected"] = sessions.value*sessions.draw_share
    sessions["roster_expected"] = sessions.value*sessions.eligible_share
    if (sessions.actual > sessions.value+1e-8).any():
        raise ValueError("Fleet payout exceeds the sampled session's Supplier payouts.")
    if ((sessions.X == 0)&(sessions.actual > 1e-8)).any():
        raise ValueError("Fleet has payouts without a selected identity.")
    daily = sessions.groupby(["date", "period"], sort=True).agg(
        sessions=("session_id", "size"), value=("value", "sum"), actual=("actual", "sum"),
        expected=("expected", "sum"), mean_X=("X", "mean"), N=("N", "first"), n=("n", "first"),
    ).reset_index()
    daily["factor"] = np.where(daily.expected > 0, daily.actual/daily.expected, np.nan)
    return sessions, daily, claims

def pmf_mixture(sessions):
    support = np.arange(int(sessions.K.max())+1)
    theory = np.zeros(len(support))
    for row in sessions.itertuples():
        p = distribution(row.N, row.n, row.cap)
        theory[:len(p)] += p/len(sessions)
    observed = np.bincount(sessions.X.to_numpy(dtype=int), minlength=len(support))/len(sessions)
    return pd.DataFrame({"X": support, "Theoretical probability": theory,
                         "Observed fraction": observed, "Observed sessions": observed*len(sessions)})

def verify_math():
    p = distribution(10, 2, 3)
    assert np.allclose(p, [56/120, 56/120, 8/120, 0])
    assert distribution(40, 4, 50)[4] == 1
    assert distribution(100, 0, 50)[0] == 1
    assert distribution(100, 100, 50)[50] == 1
    for N, n, cap in [(10, 2, 3), (1000, 60, 50), (3895, 230, 50), (1, 1, 50)]:
        p = distribution(N, n, cap)
        K = min(N, cap)
        mean = K*n/N
        var = K*(n/N)*(1-n/N)*(N-K)/(N-1) if N > 1 else 0
        assert np.isclose(p.sum(), 1)
        assert np.isclose(np.arange(K+1)@p, mean)
        assert np.isclose(((np.arange(K+1)-mean)**2)@p, var)
    # Session value must weight the selected-position share, not the presence indicator.
    assert np.isclose((1000*(5/50)+10*(1/50))/(1000+10), 100.2/1010)

import plotly.graph_objects as go
import plotly.io as pio
pio.renderers.default = "plotly_mimetype"

BLUE, ORANGE, GREY = "#356DAD", "#D28234", "#8893A2"
FIGURES = {}


def day_bootstrap(frame, repetitions=2000, seed=42):
    """Resample whole days, carrying every session's actual AND baseline together."""
    d = frame.groupby("date")[["actual", "expected"]].sum()
    denominator = float(d.expected.sum())
    point = float(d.actual.sum()/denominator) if denominator > 0 else np.nan
    result = {"F": point, "low": np.nan, "high": np.nan, "days": len(d),
              "exposed_days": int((d.expected > 0).sum()), "valid_resamples": 0}
    if len(d) < 2 or not np.isfinite(point):
        return result
    rng = np.random.default_rng(seed)
    selected_days = rng.integers(0, len(d), size=(repetitions, len(d)))
    a = d.actual.to_numpy()[selected_days].sum(axis=1)
    b = d.expected.to_numpy()[selected_days].sum(axis=1)
    ratios = a[b > 0]/b[b > 0]
    result["valid_resamples"] = len(ratios)
    if len(ratios) == repetitions:
        result["low"], result["high"] = map(float, np.quantile(ratios, [.025, .975]))
    return result


def simulate_pmf(frame, repetitions=2000, seed=42):
    """Pointwise envelope under independent hypergeometric draws, conditional on rosters."""
    rng = np.random.default_rng(seed)
    support = int(frame.K.max())+1
    frequencies = np.empty((repetitions, support))
    # Bounded batches preserve the draw order while avoiding a large repetitions × sessions array.
    for start in range(0, repetitions, 64):
        stop = min(start+64, repetitions)
        draws = rng.hypergeometric(frame.n.to_numpy(), (frame.N-frame.n).to_numpy(), frame.K.to_numpy(),
                                   size=(stop-start, len(frame)))
        frequencies[start:stop] = [np.bincount(row, minlength=support)/len(frame) for row in draws]
    low, high = np.quantile(frequencies, [.025, .975], axis=0)
    return low, high


def minimum_for_tail(others, target, cap, at_least):
    if at_least > cap:
        return None
    lo, hi = 0, max(1, at_least)
    while distribution(others+hi, hi, cap)[at_least:].sum() < target:
        hi *= 2
    while hi-lo > 1:
        mid = (lo+hi)//2
        if distribution(others+mid, mid, cap)[at_least:].sum() >= target:
            hi = mid
        else:
            lo = mid
    return hi


def walk_forward(frame, claim_frame, lookback, repetitions=2000, seed=42):
    """For each test day, fit only the preceding calendar days; check settlement timing."""
    source = frame.copy()
    source["_date"] = pd.to_datetime(source.date)
    all_days = pd.date_range(source._date.min(), source._date.max(), freq="D")
    if source._date.nunique() != len(all_days):
        raise ValueError("Missing sampled calendar days; refresh or narrow the window.")
    settlement_heights = (claim_frame.assign(_h=claim_frame.blockId.astype(int))
                          .groupby("sessionId")._h.max()) if len(claim_frame) else pd.Series(dtype=int)
    source["last_settlement_height"] = source.session_id.map(settlement_heights).fillna(0).astype(int)
    rows, predictions = [], []
    for i, day in enumerate(all_days[lookback:]):
        start = day-pd.Timedelta(days=lookback)
        train = source.loc[(source._date >= start)&(source._date < day)]
        test = source.loc[source._date.eq(day)].copy()
        first_test_height = int(test.start_height.min())
        last_settlement = int(train.last_settlement_height.max())
        info = {"date": day.strftime("%Y-%m-%d"),
                "train_start": start.strftime("%Y-%m-%d"),
                "train_end_exclusive": day.strftime("%Y-%m-%d"),
                "first_test_height": first_test_height,
                "last_training_settlement_height": last_settlement,
                "training_sessions": len(train), "test_sessions": len(test),
                "status": "ok"}
        if last_settlement >= first_test_height:
            rows.append({**info, "status": "training payouts not yet settled"})
            continue
        if train._date.nunique() != lookback:
            rows.append({**info, "status": "incomplete training days"})
            continue
        fit = day_bootstrap(train, repetitions, seed+i+1)
        if not np.isfinite(fit["F"]):
            rows.append({**info, "status": "no training exposure"})
            continue
        test["past_F"] = fit["F"]
        test["raw_prediction"] = test.expected*fit["F"]
        test["residual"] = test.actual-test.raw_prediction
        test["train_start"] = info["train_start"]
        test["train_end_exclusive"] = info["train_end_exclusive"]
        actual_F = test.actual.sum()/test.expected.sum() if test.expected.sum() > 0 else np.nan
        rows.append({**info, **fit, "actual_day_F": actual_F,
                     "actual": float(test.actual.sum()), "baseline": float(test.expected.sum()),
                     "prediction": float(test.raw_prediction.sum()),
                     "paying_sessions": int((test.value > 0).sum())})
        predictions.append(test.drop(columns=["_date"]))
    empty = source.iloc[:0].drop(columns=["_date"]).assign(
        past_F=np.nan, raw_prediction=np.nan, residual=np.nan,
        train_start="", train_end_exclusive="")
    return (pd.DataFrame(rows) if rows else pd.DataFrame(columns=["date", "status"])), pd.concat(predictions, ignore_index=True) if predictions else empty


def residual_group(frame, key):
    """Descriptive summaries, not another fitted model."""
    result = frame.groupby(key, observed=True).agg(
        Sessions=("session_id", "size"), Actual=("actual", "sum"),
        Predicted=("raw_prediction", "sum"), Mean_error=("residual", "mean"))
    result["Actual / predicted"] = result.Actual.div(result.Predicted.replace(0, np.nan))
    return result

# ---- Historical cache and assembly ----
# Shared historical inputs are independent of the owner selected for analysis.
import re
import shutil
import uuid
from dataclasses import dataclass
from functools import lru_cache

SAMPLING = {"Quick": (3, 15), "Standard": (3, 9, 15, 21), "Dense": tuple(range(24))}
CLAIM_COLUMNS = ["id", "supplierId", "serviceId", "applicationId", "sessionId", "sessionEndHeight",
                 "blockId", "numEstimatedRelays", "numEstimatedComputedUnits", "payout_upokt", "transfer_count"]
CLAIM_COLUMNS += ['numRelays', 'numClaimedComputedUnits', 'settledAmount', 'settledDenom', 'mintRatio', 'mintedAmount', 'mintedDenom', 'overservicingLossAmount', 'deflationLossAmount']
TABLE_NAMES = ["schedule", "registry", "sessions", "members", "claims", "payout_queries"]


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:20]


class HistoricalCache:
    def __init__(self, root):
        self.root = Path(root)
        self.namespace = {"schema": 4, "chain": "pocket", "api": API, "indexer": GRAPHQL}
        for part in ("raw", "datasets", "results", "runs"):
            (self.root/part).mkdir(parents=True, exist_ok=True)
        self.hits, self.misses = 0, 0

    def path(self, kind, key):
        return self.root/"raw"/kind/(fingerprint([self.namespace, key])+".json.gz")

    def has(self, kind, key):
        return self.path(kind, key).exists()

    def read(self, kind, key):
        with gzip.open(self.path(kind, key), "rt") as f:
            record = json.load(f)
        if record["key"] != key or record["namespace"] != self.namespace:
            raise ValueError("Cache identity mismatch.")
        return record["data"]

    def write(self, kind, key, data):
        path = self.path(kind, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name+"."+uuid.uuid4().hex+".tmp")
        with gzip.open(temp, "wt") as f:
            json.dump({"namespace": self.namespace, "key": key, "data": data}, f, separators=(",", ":"))
        temp.replace(path)
        return data

    def get(self, kind, key, fetch):
        if self.has(kind, key):
            self.hits += 1
            return self.read(kind, key)
        self.misses += 1
        return self.write(kind, key, fetch())

    def catalog(self):
        rows = []
        for path in sorted((self.root/"datasets").glob("*/manifest.json")):
            item = json.loads(path.read_text())
            if item.get("complete") and item.get("namespace") == self.namespace:
                rows.append(item)
        return rows

    def load(self, dataset_id):
        path = self.root/"datasets"/dataset_id
        meta = json.loads((path/"manifest.json").read_text())
        if not meta.get("complete") or meta["namespace"] != self.namespace:
            raise ValueError("Dataset is incomplete or belongs to different data sources.")
        return {"meta": meta, **{name: pd.read_parquet(path/(name+".parquet")) for name in TABLE_NAMES}}

    def publish(self, tables, metadata):
        # A published dataset is immutable. Payout refreshes create a new version.
        dataset_id = metadata["dataset_id"]
        target = self.root/"datasets"/dataset_id
        if (target/"manifest.json").exists():
            return dataset_id
        staging = self.root/"datasets"/("_building_"+uuid.uuid4().hex)
        staging.mkdir()
        for name in TABLE_NAMES:
            tables[name].to_parquet(staging/(name+".parquet"), index=False, compression="zstd")
        meta = {**metadata, "complete": True, "namespace": self.namespace,
                "table_rows": {name: len(tables[name]) for name in TABLE_NAMES}}
        (staging/"manifest.json").write_text(json.dumps(meta, indent=2, default=str))
        staging.rename(target)
        return dataset_id


def validate_tables(tables):
    s, members, registry, claims, queries = [tables[k] for k in ("sessions", "members", "registry", "claims", "payout_queries")]
    if s.empty or not s.session_id.is_unique:
        raise ValueError("Need a nonempty, unique session sample.")
    if registry.duplicated(["height", "operator"]).any() or members.duplicated(["session_id", "operator"]).any():
        raise ValueError("Duplicate historical identity.")
    if not set(s.session_id) == set(queries.session_id) or not queries.complete.all():
        raise ValueError("Every roster needs a completed payout query, including empty responses.")
    sizes = members.groupby("session_id").size()
    if not np.array_equal(s.session_id.map(sizes).to_numpy(), s.K.to_numpy()):
        raise ValueError("Session roster size mismatch.")
    if not (s.K == np.minimum(s.N, s.cap)).all():
        raise ValueError("Unexpected historical session size.")
    joined = members.merge(s[["session_id", "height"]], on="session_id", validate="many_to_one")
    joined = joined.merge(registry, on=["height", "operator"], how="left", suffixes=("", "_registry"), validate="many_to_one")
    if not joined.owner.eq(joined.owner_registry).all():
        raise ValueError("Historical roster disagrees with historical eligibility or ownership.")
    if not claims.empty:
        if not claims.id.is_unique or claims.duplicated(["sessionId", "supplierId"]).any():
            raise ValueError("Duplicate settled claim.")
        checked = claims.merge(members[["session_id", "operator"]], left_on=["sessionId", "supplierId"],
                               right_on=["session_id", "operator"], how="left", validate="one_to_one")
        if checked.operator.isna().any():
            raise ValueError("A paid Supplier is absent from its historical session.")
        checked = claims.merge(s, left_on="sessionId", right_on="session_id", validate="many_to_one")
        if not checked.applicationId.eq(checked.application).all() or not checked.sessionEndHeight.astype(int).eq(checked.end_height).all():
            raise ValueError("Claim and historical session headers disagree.")
        if any(not Decimal(v).is_finite() or Decimal(v) < 0 for v in claims.payout_upokt):
            raise ValueError("Invalid Supplier payout.")


def normalise_study(study):
    schedule = pd.DataFrame([{k: p[k] for k in ["height", "timestamp", "scheduled_at", "N", "cap"]}
                             for p in study["populations"]])
    registry = pd.DataFrame([(p["height"], a, o) for p in study["populations"] for a, o in p["rows"]],
                            columns=["height", "operator", "owner"])
    sessions = pd.DataFrame([{k: s[k] for k in ["height", "timestamp", "scheduled_at", "application", "session_id",
                                             "start_height", "end_height", "N", "cap", "K"]} for s in study["sessions"]])
    members = pd.DataFrame([(s["session_id"], a, o) for s in study["sessions"] for a, o in s["selected"]],
                           columns=["session_id", "operator", "owner"])
    claims = pd.DataFrame(study["claims"], columns=CLAIM_COLUMNS)
    queries = pd.DataFrame({"session_id": sessions.session_id, "complete": True,
                            "cutoff": int(study["latest_settlement"]["blockId"]), "fetched_at": study["fetched_at"]})
    tables = dict(schedule=schedule, registry=registry, sessions=sessions, members=members, claims=claims, payout_queries=queries)
    validate_tables(tables)
    return tables


def import_saved_study(cache, study, label="V3 saved · Quick"):
    # Import the supplied evidence, including all owners; do not attribute it only to the demo owner.
    identity = fingerprint([study["start"], study["end"], study["config"]["service"], study["fetched_at"], study["claims"]])
    dataset_id = "saved_"+identity
    if (cache.root/"datasets"/dataset_id/"manifest.json").exists():
        return dataset_id
    service = study["config"]["service"]
    for p in study["populations"]:
        h = p["height"]
        cache.write("block", p["scheduled_at"], {k: p[k] for k in ["height", "timestamp", "scheduled_at"]})
        cache.write("population", [service, h], {"height": h, "rows": p["rows"], "pages": p.get("pages", 1)})
        cache.write("cap", h, p["cap"])
    if len(study["applications"]) == study["available_applications_at_start"]:
        cache.write("service_apps", [service, study["populations"][0]["height"]], study["applications"])
    for s in study["sessions"]:
        cache.write("session", [service, s["height"], s["application"]],
                    {k: s[k] for k in ["height", "application", "session_id", "start_height", "end_height", "selected"]})
    claims_by_session = {}
    for c in study["claims"]:
        claims_by_session.setdefault(c["sessionId"], []).append(c)
    for s in study["sessions"]:
        cache.write("payout", [service, s["session_id"]], {"claims": claims_by_session.get(s["session_id"], []),
                    "cutoff": int(study["latest_settlement"]["blockId"]), "fetched_at": study["fetched_at"], "complete": True})
    tables = normalise_study(study)
    config = {"service": service, "start": study["start"][:10], "end": study["end"][:10],
              "hours": study["config"]["hours"], "app_policy": "fixed", "applications": study["applications"]}
    meta = {"dataset_id": dataset_id, "label": label, "service": service, "config": config,
            "start": study["start"], "end": study["end"], "fetched_at": study["fetched_at"],
            "source": "Supplied V3 historical snapshot", "scheduled_lookups": len(tables["sessions"]),
            "application_policy": "Fixed at the first sample; all 3 then-eligible BSC Applications",
            "http_attempts": 0, "build_seconds": None, "selection_rule": "Preserved V3 sample"}
    return cache.publish(tables, meta)


def fetch_application_registry(height):
    apps, cursor, seen = {}, None, set()
    for _ in range(100):
        params = {"pagination.limit": 1000}
        if cursor:
            params["pagination.key"] = cursor
        result = rest("/pokt-network/poktroll/application/application", height, **params)
        for app in result["applications"]:
            apps[app["address"]] = sorted(c["service_id"] for c in app.get("service_configs", []))
        cursor = result.get("pagination", {}).get("next_key")
        if not cursor:
            return apps
        if cursor in seen:
            raise ValueError("Repeated Application pagination cursor.")
        seen.add(cursor)
    raise ValueError("Application pagination did not finish.")


def historical_apps(cache, service, height):
    def fetch():
        registry = cache.get("applications", height, lambda: fetch_application_registry(height))
        return sorted(a for a, services in registry.items() if service in services)
    return cache.get("service_apps", [service, height], fetch)


def resolve_schedule(cache, start, end, hours):
    days = pd.date_range(start, end, inclusive="left", freq="D", tz="UTC")
    times = [(day+pd.Timedelta(hours=h)).isoformat() for day in days for h in hours]
    missing = [t for t in times if not cache.has("block", t)]
    for offset in range(0, len(missing), 24):
        part = missing[offset:offset+24]
        fields = ['b%d:blocks(first:1,orderBy:ID_ASC,filter:{timestamp:{greaterThanOrEqualTo:%s}}){nodes{id timestamp}}'
                  % (i, json.dumps(t)) for i, t in enumerate(part)]
        result = graphql("{"+"\n".join(fields)+"}")
        for i, target in enumerate(part):
            rows = result[f"b{i}"]["nodes"]
            if not rows or not timedelta(0) <= utc(rows[0]["timestamp"])-utc(target) < timedelta(minutes=10):
                raise ValueError("Indexer cannot resolve a requested time accurately.")
            cache.write("block", target, {"height": int(rows[0]["id"]), "timestamp": rows[0]["timestamp"], "scheduled_at": target})
    return [cache.read("block", t) for t in times]


def _build_dataset_v4(cache, service, start, end, mode="Quick", hours=None, app_policy="all", applications=(),
                  app_limit=None, refresh_payouts=False, workers=4):
    """Deliberate network stage. Changing a fleet in the explorer never calls this function."""
    started, metric_start = time.perf_counter(), len(HTTP_METRICS)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", service):
        raise ValueError("Enter a service ID, for example bsc or eth.")
    start, end = utc(start), utc(end)
    if start >= end or any(t.hour or t.minute or t.second or t.microsecond for t in (start, end)):
        raise ValueError("Use increasing whole UTC dates; end is excluded.")
    hours = tuple(sorted(SAMPLING[mode] if hours is None else hours))
    if not hours or len(set(hours)) != len(hours) or any(type(h) is not int or not 0 <= h < 24 for h in hours):
        raise ValueError("Use distinct integer UTC hours from 0 to 23.")
    if app_policy not in ("all", "fixed", "first_n") or (app_policy == "fixed" and not applications):
        raise ValueError("Choose all historical Applications, an explicit fixed list, or first N alphabetically.")
    if app_policy == "first_n" and (not isinstance(app_limit, int) or app_limit < 1):
        raise ValueError("First N needs a positive Application limit.")
    config = {"service": service, "start": start.strftime("%Y-%m-%d"), "end": end.strftime("%Y-%m-%d"),
              "hours": list(hours), "app_policy": app_policy, "applications": sorted(set(applications)),
              "app_limit": app_limit if app_policy == "first_n" else None}
    same = [m for m in cache.catalog() if m["config"] == config]
    if same and not refresh_payouts:
        selected = max(same, key=lambda m: m["fetched_at"])
        print("Exact dataset already cached: 0 HTTP requests.")
        return selected["dataset_id"]
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")+"_"+fingerprint(config)[:8]
    report = {"run_id": run_id, "config": config, "status": "building"}
    (cache.root/"runs"/(run_id+".json")).write_text(json.dumps(report, indent=2))
    try:
        latest = graphql('''query($s:String!){eventClaimSettleds(first:1,orderBy:BLOCK_ID_DESC,
            filter:{serviceId:{equalTo:$s}}){nodes{blockId block{timestamp}}}}''', s=service)["eventClaimSettleds"]["nodes"]
        if not latest:
            raise ValueError("No indexed settlements found for this service.")
        latest = latest[0]
        mature_end = utc(latest["block"]["timestamp"]).replace(hour=0, minute=0, second=0, microsecond=0)-timedelta(days=1)
        if end > mature_end:
            raise ValueError(f"End date must be no later than {mature_end.date()} to retain the settlement lag.")
        chain = rest("/cosmos/base/tendermint/v1beta1/blocks/latest")["block"]["header"]
        if chain["chain_id"] != "pocket":
            raise ValueError("Expected Pocket mainnet.")
        schedule = resolve_schedule(cache, start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"), hours)
        def collect_point(point):
            h = point["height"]
            available = historical_apps(cache, service, h)
            chosen = available if app_policy == "all" else (
                available[:app_limit] if app_policy == "first_n" else sorted(set(applications)))
            if any(a not in available for a in chosen):
                raise ValueError(f"A fixed Application was not eligible at block {h}; change the cohort explicitly.")
            pop = historical_population(cache, service, h)
            cap = cache.get("cap", h, lambda: int(rest("/pokt-network/poktroll/session/params", h)["params"]["num_suppliers_per_session"]))
            rosters = [cache.get("session", [service, h, app], lambda app=app: fetch_session(service, h, app)) for app in chosen]
            return {**point, "N": len(pop["rows"]), "cap": cap}, pop, rosters, len(available)
        collected, failures = [], []
        print(f"{service}: {len(schedule)} historical times; {len(hours)} samples/day; Application policy: {app_policy}.")
        with ThreadPoolExecutor(max_workers=min(4, max(1, workers))) as pool:
            tasks = {pool.submit(collect_point, point): point for point in schedule}
            for i, future in enumerate(as_completed(tasks), 1):
                try:
                    collected.append(future.result())
                except Exception as exc:
                    failures.append({"point": tasks[future], "reason": str(exc)[:400]})
                if i % 10 == 0 or i == len(tasks):
                    print(f"Historical times completed: {i}/{len(tasks)}", flush=True)
        if failures:
            report["failures"] = failures
            raise RuntimeError(f"{len(failures)} historical times failed. Completed requests are cached; rerun to resume. First: {failures[0]['reason']}")
        collected.sort(key=lambda item: item[0]["height"])
        roster_rows, member_rows, pop_rows, schedule_rows = [], [], [], []
        seen_sessions, scheduled_lookups = set(), 0
        for point, pop, rosters, available_count in collected:
            schedule_rows.append({**point, "available_applications": available_count, "chosen_applications": len(rosters)})
            pop_rows.extend((point["height"], a, o) for a, o in pop["rows"])
            for roster in rosters:
                scheduled_lookups += 1
                sid = roster["session_id"]
                if sid in seen_sessions:
                    continue  # Repeated requests for the same session must not count as independent observations.
                seen_sessions.add(sid)
                roster_rows.append({**point, **{k: v for k, v in roster.items() if k != "selected"}, "K": len(roster["selected"])})
                member_rows.extend((sid, a, o) for a, o in roster["selected"])
        session_ids = [r["session_id"] for r in roster_rows]
        if not session_ids:
            raise ValueError("No sampled sessions: no chosen Applications were eligible in this period.")
        pending = [sid for sid in session_ids if refresh_payouts or not cache.has("payout", [service, sid])]
        print(f"{len(session_ids)} unique sessions; payout queries missing/refreshed: {len(pending)}.", flush=True)
        cache_payout_batches(cache, service, pending, int(latest["blockId"]), refresh=True, workers=workers)
        claim_rows, query_rows = [], []
        for sid in session_ids:
            result = cache.read("payout", [service, sid])
            claim_rows.extend(result["claims"])
            query_rows.append({"session_id": sid, **{k: result[k] for k in ["cutoff", "fetched_at", "complete"]}})
        tables = {"schedule": pd.DataFrame(schedule_rows),
                  "registry": pd.DataFrame(pop_rows, columns=["height", "operator", "owner"]).drop_duplicates(),
                  "sessions": pd.DataFrame(roster_rows),
                  "members": pd.DataFrame(member_rows, columns=["session_id", "operator", "owner"]),
                  "claims": pd.DataFrame(claim_rows, columns=CLAIM_COLUMNS), "payout_queries": pd.DataFrame(query_rows)}
        validate_tables(tables)
        metrics = HTTP_METRICS[metric_start:]
        report.update(status="complete", build_seconds=time.perf_counter()-started, http_attempts=len(metrics),
                      downloaded_mb=sum(m["bytes"] for m in metrics)/1e6, scheduled_lookups=scheduled_lookups,
                      unique_sessions=len(session_ids), new_payout_queries=len(pending))
        dataset_id = "data_"+fingerprint([config, query_rows])
        label = f"{mode} · {start:%d %b}–{end:%d %b} · {len(hours)}/day · {app_policy} Apps"
        meta = {**report, "dataset_id": dataset_id, "label": label, "service": service,
                "start": start.isoformat(), "end": end.isoformat(), "fetched_at": datetime.now(timezone.utc).isoformat(),
                "source": "Public historical APIs", "collector_version": "V5 height registry", "application_policy": app_policy,
                "selection_rule": "Sampling times and Application rule fixed before fetching payouts"}
        cache.publish(tables, meta)
        print(f"Saved {len(session_ids)} sessions in {report['build_seconds']:.1f}s; {len(metrics)} HTTP attempts; {report['downloaded_mb']:.2f} MB received.")
        return dataset_id
    except Exception as exc:
        report.update(status="failed", reason=str(exc), build_seconds=time.perf_counter()-started,
                      http_attempts=len(HTTP_METRICS)-metric_start)
        raise
    finally:
        (cache.root/"runs"/(run_id+".json")).write_text(json.dumps(report, indent=2, default=str))


def window_tables(bundle, start=None, end=None):
    meta = bundle["meta"]
    start, end = utc(start or meta["start"]), utc(end or meta["end"])
    if start < utc(meta["start"]) or end > utc(meta["end"]) or start >= end:
        raise ValueError("Choose a nonempty window wholly inside this cached dataset.")
    schedule = bundle["schedule"]
    times = pd.to_datetime(schedule.timestamp, utc=True)
    schedule = schedule.loc[times.ge(start)&times.lt(end)].copy()
    heights = set(schedule.height)
    sessions = bundle["sessions"].loc[bundle["sessions"].height.isin(heights)].copy()
    if sessions.empty:
        raise ValueError("No cached sessions in that window.")
    ids = set(sessions.session_id)
    return {"meta": {**meta, "selected_start": start.isoformat(), "selected_end": end.isoformat()},
            "schedule": schedule, "sessions": sessions,
            "registry": bundle["registry"].loc[bundle["registry"].height.isin(heights)].copy(),
            "members": bundle["members"].loc[bundle["members"].session_id.isin(ids)].copy(),
            "claims": bundle["claims"].loc[bundle["claims"].sessionId.isin(ids)].copy(),
            "payout_queries": bundle["payout_queries"].loc[bundle["payout_queries"].session_id.isin(ids)].copy()}


def assemble_case(bundle, owner=None, operators=()):
    """Historical identity selection and unchanged V3 reward attribution; no network access."""
    if bool(owner) == bool(operators):
        raise ValueError("Choose one owner OR a list of Supplier operator identities.")
    if len(operators) != len(set(operators)):
        raise ValueError("Supplier identities must be unique.")
    registry, members, schedule = bundle["registry"], bundle["members"], bundle["schedule"].sort_values("height")
    owned = registry.loc[registry.owner.eq(owner) if owner else registry.operator.isin(operators)]
    if owned.empty:
        raise ValueError("No historically eligible Suppliers match this selection.")
    fleet_at = owned.groupby("height").operator.agg(list).to_dict()
    owner_rows = {h: list(g[["operator", "owner"]].itertuples(index=False, name=None)) for h, g in registry.groupby("height")}
    selected_rows = {sid: list(g[["operator", "owner"]].itertuples(index=False, name=None)) for sid, g in members.groupby("session_id")}
    populations = [{**r, "rows": owner_rows[r["height"]], "fleet": sorted(fleet_at.get(r["height"], [])),
                    "n": len(fleet_at.get(r["height"], []))} for r in schedule.to_dict("records")]
    rows = []
    for s in bundle["sessions"].sort_values(["height", "application"]).to_dict("records"):
        fleet = set(fleet_at.get(s["height"], []))
        selected = selected_rows[s["session_id"]]
        intersection = sorted(fleet.intersection(a for a, o in selected))
        rows.append({**s, "selected": selected, "n": len(fleet), "X": len(intersection), "fleet_selected": intersection})
    start, end = utc(bundle["meta"]["selected_start"]), utc(bundle["meta"]["selected_end"])
    days = (end-start).days
    # As in V3, split on a UTC day boundary. Odd windows put the extra day in the later half.
    split = start+timedelta(days=days//2)
    study = {"start": start.isoformat(), "end": end.isoformat(), "split": split.isoformat(),
             "config": {"service": bundle["meta"]["service"], "owner": owner, "operators": list(operators)},
             "populations": populations, "sessions": rows, "claims": bundle["claims"].to_dict("records")}
    sessions, daily, claims = make_frames(study)
    app_labels = {a: f"A{i+1}" for i, a in enumerate(sorted(sessions.application.unique()))}
    sessions["App"] = sessions.application.map(app_labels)
    return {"study": study, "sessions": sessions, "daily": daily, "claims": claims,
            "population": pd.DataFrame(populations), "app_labels": app_labels, "bundle": bundle}


def owner_catalog(bundle):
    """List historical owners by fleet size, never rank on performance."""
    reg, schedule = bundle["registry"], bundle["schedule"]
    counts = reg.groupby(["owner", "height"]).size().unstack(fill_value=0).reindex(columns=schedule.height, fill_value=0)
    return pd.DataFrame({"owner": counts.index, "n_min": counts.min(axis=1).values,
                         "n_max": counts.max(axis=1).values, "n_latest": counts.iloc[:, -1].values}).sort_values(
                             ["n_max", "owner"], ascending=[False, True]).reset_index(drop=True)


def coverage_summary(case, lookback=7):
    s, pop, b = case["sessions"], case["population"], case["bundle"]
    start, end = b["meta"]["selected_start"], b["meta"]["selected_end"]
    fleet_sets = pop.fleet.map(lambda x: tuple(sorted(x)))
    count_changes = int(pop.n.diff().dropna().ne(0).sum())
    identity_changes = max(0, int(fleet_sets.ne(fleet_sets.shift()).sum())-1)
    requested_days = (utc(end)-utc(start)).days
    rows = [
        ("Requested UTC period", f"{start[:10]} to {end[:10]} (end excluded)"),
        ("Unique sampled sessions / valid rosters", f"{len(s):,} / {len(s):,}"),
        ("Completed payout queries", f"{len(b['payout_queries']):,}/{len(s):,}"),
        ("Sessions with indexed claims", f"{int(s.claims.gt(0).sum()):,} ({s.claims.gt(0).mean():.1%})"),
        ("Sessions with positive indexed payout", f"{int(s.value.gt(0).sum()):,} ({s.value.gt(0).mean():.1%})"),
        ("Applications / payout-bearing Applications", f"{s.application.nunique()} / {s.loc[s.value.gt(0),'application'].nunique()}"),
        ("Sampled UTC days / requested days", f"{s.date.nunique()} / {requested_days}"),
        ("Our eligible Suppliers, n (min–max)", f"{pop.n.min():,}–{pop.n.max():,}"),
        ("Observed fleet-size changes / membership changes", f"{count_changes} / {identity_changes}"),
        ("Sessions with our exposure / positive baseline", f"{s.X.gt(0).sum()} / {s.expected.gt(0).sum()}"),
        ("Settlement snapshot blocks (min–max)", f"{b['payout_queries'].cutoff.min():,}–{b['payout_queries'].cutoff.max():,}"),
    ]
    warnings = []
    if s.date.nunique() != requested_days:
        warnings.append("Some requested days have no sampled sessions; rolling validation will be unavailable across these gaps.")
    if s.value.gt(0).mean() < 1:
        warnings.append(f"{s.value.eq(0).sum()} sessions have zero indexed payout. Queries completed; this does not establish zero traffic.")
    if s.loc[s.value.gt(0), "application"].nunique() < 2:
        warnings.append("Fewer than two payout-bearing Applications: Application effects cannot be compared.")
    if s.expected.gt(0).sum() == 0:
        warnings.append("No positive fleet opportunity baseline: F is undefined for this case.")
    if s.date.nunique() <= lookback:
        warnings.append(f"At most {lookback} days: no held-out day follows the full training window.")
    if b['payout_queries'].cutoff.nunique() > 1:
        warnings.append("This dataset reuses payout snapshots from different collection dates; exact cutoffs are retained per session. Refresh payouts deliberately to align them.")
    return pd.DataFrame(rows, columns=["Coverage", "Observed"]), warnings

# ---- Case analysis ----
def analyse_case(case, lookback=7, repetitions=2000, seed=42):
    """The same statistics for every case. Inputs are already-cached historical tables."""
    s, c = case["sessions"], case["claims"]
    out = {**case, "lookback": lookback, "repetitions": repetitions, "seed": seed}
    out["coverage"], out["warnings"] = coverage_summary(case, lookback)
    pmf = pmf_mixture(s)
    low, high = simulate_pmf(s, repetitions, seed)
    pmf["Simulation low"] = low
    pmf["Simulation high"] = high
    out["pmf"] = pmf
    out["outside_pmf"] = int(((pmf["Observed fraction"] < low-1e-12)|(pmf["Observed fraction"] > high+1e-12)).sum())
    out["bootstrap"] = day_bootstrap(s, repetitions, seed)
    out["F"] = float(s.actual.sum()/s.expected.sum()) if s.expected.sum() > 0 else np.nan
    last = case["population"].sort_values("height").iloc[-1]
    out["last_stats"] = exposure_stats(int(last.N), int(last.n), int(last.cap))
    out["periods"] = s.groupby("period")[["value", "actual", "expected"]].sum().reindex(["Earlier", "Later"])
    out["periods"]["F"] = out["periods"].actual.div(out["periods"].expected.replace(0, np.nan))
    out["split_mae"], out["split_baseline_mae"] = np.nan, np.nan
    train, test = s.loc[s.period.eq("Earlier")], s.loc[s.period.eq("Later")].copy()
    fit = out["periods"].loc["Earlier", "F"]
    training_claims = c.loc[c.sessionId.isin(train.session_id)] if len(c) else c
    timing_ok = (len(test) > 0 and (training_claims.empty or int(training_claims.blockId.astype(int).max()) < int(test.start_height.min())))
    if np.isfinite(fit) and len(test) and test.value.sum() > 0 and timing_ok:
        test["prediction"] = np.minimum(test.value, fit*test.expected)
        test.loc[test.X.eq(test.K), "prediction"] = test.loc[test.X.eq(test.K), "value"]
        d = test.groupby("date")[["actual", "expected", "prediction"]].sum()
        out["split_mae"] = float((d.actual-d.prediction).abs().mean())
        out["split_baseline_mae"] = float((d.actual-d.expected).abs().mean())
        out["split_status"] = "ok"
    else:
        out["split_status"] = "Unavailable: insufficient exposure, later payout, or settlement timing."
    try:
        rolling, heldout = walk_forward(s, c, lookback, repetitions, seed)
        out["rolling_status"] = "ok"
    except ValueError as exc:
        rolling = pd.DataFrame(columns=["date", "status"])
        heldout = s.iloc[:0].assign(past_F=np.nan, raw_prediction=np.nan, residual=np.nan)
        out["rolling_status"] = str(exc)
    out["rolling"], out["heldout"] = rolling, heldout
    valid = rolling.loc[rolling.status.eq("ok")]
    out["valid_rolling"] = valid
    out["walk_mae"], out["walk_baseline_mae"] = np.nan, np.nan
    if len(heldout):
        d = heldout.groupby("date")[["actual", "expected", "raw_prediction"]].sum()
        out["walk_mae"] = float((d.actual-d.raw_prediction).abs().mean())
        out["walk_baseline_mae"] = float((d.actual-d.expected).abs().mean())
    out["bound_flags"] = int(((heldout.raw_prediction > heldout.value+1e-8) |
                              ((heldout.X == heldout.K)&((heldout.raw_prediction-heldout.value).abs() > 1e-8))).sum())
    residuals = heldout.loc[heldout.value.gt(0)].copy()
    residuals["hour"] = pd.to_datetime(residuals.scheduled_at, utc=True).dt.hour
    residuals["X group"] = np.where(residuals.X <= 3, "X ≤ 3", "X ≥ 4")
    residuals["Value group"] = np.where(residuals.value <= residuals.value.median(), "At/below median V", "Above median V")
    out["residuals"] = residuals
    out["hour_diagnostic"] = residual_group(residuals, "hour")
    out["x_diagnostic"] = residual_group(residuals, "X group")
    out["value_diagnostic"] = residual_group(residuals, "Value group")
    # Data integrity, not a statistical declaration of model correctness.
    assert s.session_id.is_unique and np.isclose(pmf["Theoretical probability"].sum(), 1)
    assert np.all(s.actual <= s.value+1e-8)
    if len(valid):
        assert (valid.last_training_settlement_height < valid.first_test_height).all()
        assert (pd.to_datetime(heldout.train_end_exclusive) == pd.to_datetime(heldout.date)).all()
        assert np.allclose(heldout.residual, heldout.actual-heldout.past_F*heldout.expected)
    return out


def save_analysis(cache, result):
    meta = result["bundle"]["meta"]
    config = {"analysis_version": "V5.0; preserved V4 statistical definitions", "dataset_id": meta["dataset_id"], "start": meta["selected_start"], "end": meta["selected_end"],
              **result["study"]["config"], "lookback": result["lookback"], "repetitions": result["repetitions"], "seed": result["seed"]}
    folder = cache.root/"results"/fingerprint(config)
    folder.mkdir(parents=True, exist_ok=True)
    scalar = {"F": result["F"], "bootstrap": result["bootstrap"], "walk_mae": result["walk_mae"],
              "equal_performance_mae": result["walk_baseline_mae"], "warnings": result["warnings"]}
    (folder/"analysis.json").write_text(json.dumps({"config": config, "summary": scalar, "versions": {"numpy": np.__version__, "pandas": pd.__version__}}, indent=2, default=str))
    result["sessions"].drop(columns=["selected", "fleet_selected"], errors="ignore").to_parquet(folder/"session_analysis.parquet", index=False)
    result["rolling"].to_parquet(folder/"walk_forward.parquet", index=False)
    return folder


def eligible_random_cases(cache, window_days=None, service=None, minimum_sessions=28, minimum_payout_fraction=.2,
                          minimum_days=14, minimum_exposed_sessions=5, start_date=None, end_date=None):
    """Filter on coverage and opportunity, never on estimated F or the sign of a result."""
    choices = {}
    for meta in cache.catalog():
        if service and meta["service"] != service:
            continue
        end = utc(end_date or meta["end"])
        start = utc(start_date) if start_date else (end-timedelta(days=window_days) if window_days else utc(meta["start"]))
        if start < utc(meta["start"]) or end > utc(meta["end"]) or start >= end:
            continue
        bundle = window_tables(cache.load(meta["dataset_id"]), start, end)
        s, claims = bundle["sessions"], bundle["claims"]
        days = pd.to_datetime(s.timestamp, utc=True).dt.date.nunique()
        paid_ids = set(claims.loc[claims.payout_upokt.map(lambda v: Decimal(v) > 0), "sessionId"])
        if len(s) < minimum_sessions or days < minimum_days or s.session_id.isin(paid_ids).mean() < minimum_payout_fraction:
            continue
        exposed = bundle["members"].loc[bundle["members"].session_id.isin(paid_ids)].groupby("owner").session_id.nunique()
        for owner in owner_catalog(bundle).owner:
            if exposed.get(owner, 0) < minimum_exposed_sessions:
                continue
            key = (meta["service"], owner)
            candidate = {"service": meta["service"], "owner": owner, "dataset_id": meta["dataset_id"],
                         "start": start.isoformat(), "end": end.isoformat(), "sessions": len(s), "days": days, "fetched_at": meta["fetched_at"]}
            # Avoid giving one operator/service more chances merely because it has multiple cache versions.
            if key not in choices or (candidate["sessions"], candidate["fetched_at"]) > (choices[key]["sessions"], choices[key]["fetched_at"]):
                choices[key] = candidate
    return list(choices.values())
# ---- V5 collection: one historical registry per height ----
from contextlib import contextmanager
from threading import RLock
_BUILD_LOCK = RLock()
_JOURNAL_LOCK = RLock()

@contextmanager
def network_stage(cache):
    """The app never enters this context. Serialize deliberate builds in one process."""
    global NETWORK_ENABLED, RAW_RESPONSE_DIR, HTTP_JOURNAL_PATH
    with _BUILD_LOCK:
        old_enabled, old_dir, old_journal = NETWORK_ENABLED, RAW_RESPONSE_DIR, HTTP_JOURNAL_PATH
        NETWORK_ENABLED = True
        RAW_RESPONSE_DIR = cache.root/'http'
        RAW_RESPONSE_DIR.mkdir(parents=True, exist_ok=True)
        HTTP_JOURNAL_PATH = cache.root/'runs'/'http_attempts.jsonl'
        try:
            yield
        finally:
            NETWORK_ENABLED, RAW_RESPONSE_DIR, HTTP_JOURNAL_PATH = old_enabled, old_dir, old_journal


def fetch_height_registry(height):
    records, cursor, seen = {}, None, set()
    for page in range(100):
        params = {'dehydrated': 'true', 'pagination.limit': 10000}
        if cursor:
            params['pagination.key'] = cursor
        response = rest('/pokt-network/poktroll/supplier/supplier', height, **params)
        for supplier in response['supplier']:
            operator, owner = supplier['operator_address'], supplier['owner_address']
            if not operator or not owner:
                raise ValueError('Incomplete historical Supplier identity.')
            value = {'operator': operator, 'owner': owner,
                     'services': sorted({v['service_id'] for v in supplier['services']})}
            if operator in records and records[operator] != value:
                raise ValueError('Conflicting historical registry records.')
            records[operator] = value
        cursor = response.get('pagination', {}).get('next_key')
        if not cursor:
            return {'height': height, 'rows': sorted(records.values(), key=lambda v: v['operator']), 'pages': page+1,
                    'eligibility': 'Historical API active services; no current-state or unstake filter'}
        if cursor in seen:
            raise ValueError('Repeated registry pagination cursor.')
        seen.add(cursor)
    raise RuntimeError('Registry pagination did not finish.')


def historical_population(cache, service, height):
    # Existing service-specific records remain valid and reusable.
    if cache.has('population', [service, height]):
        return cache.read('population', [service, height])
    full = cache.get('registry_height', height, lambda: fetch_height_registry(height))
    # At overlapping old sample heights, independently compare the shared registry
    # with V4's original server-filtered records before using it for another service.
    for check_service in ('bsc', 'base', 'robinhood', 'eth'):
        if cache.has('population', [check_service, height]):
            old = sorted(tuple(v) for v in cache.read('population', [check_service, height])['rows'])
            derived = sorted((v['operator'], v['owner']) for v in full['rows'] if check_service in v['services'])
            if old != derived:
                raise ValueError(f'Shared registry disagrees with cached {check_service} eligibility at {height}.')
    rows = [(v['operator'], v['owner']) for v in full['rows'] if service in v['services']]
    if not rows:
        raise ValueError(f'No eligible Suppliers for {service} at {height}.')
    return cache.write('population', [service, height], {'height': height, 'rows': rows,
                         'pages': full['pages'], 'source': 'shared height registry'})


def build_dataset(cache, service, start, end, mode='Standard', **kwargs):
    """Explicit Part A. Frozen snapshots and all successful raw responses are retained."""
    with network_stage(cache):
        return _build_dataset_v4(cache, service, start, end, mode=mode, **kwargs)


def build_many(cache, services, start, end, mode='Standard', **kwargs):
    """Common dates/times reuse blocks, registries, caps and Application state."""
    return {s: build_dataset(cache, s, start, end, mode=mode, **kwargs) for s in services}


def dataset_catalog(cache):
    return pd.DataFrame([{'dataset_id': m['dataset_id'], 'service': m['service'],
                         'start': m['start'][:10], 'end_exclusive': m['end'][:10],
                         'hours_utc': ', '.join(f'{v:02d}' for v in m['config']['hours']),
                         'application_policy': m['config']['app_policy'],
                         'sessions': m['table_rows']['sessions'], 'collected': m['fetched_at']}
                        for m in cache.catalog()])


def analyse_cached(cache, dataset_id, owner=None, operators=(), start=None, end=None,
                   lookback=7, repetitions=2000, seed=42, save=True):
    """Purely local Part B. Both notebook and app call this exact entry point."""
    bundle = window_tables(cache.load(dataset_id), start, end)
    result = analyse_case(assemble_case(bundle, owner=owner, operators=operators), lookback, repetitions, seed)
    if save:
        save_analysis(cache, result)
    return result


def restore_compact_records(cache):
    """Reconstruct reusable normalized request records from bundled frozen tables.

    This is local restoration, not a claim that original full HTTP responses exist
    for legacy V4 snapshots. New HTTP responses are separately preserved in http/.
    """
    for meta in cache.catalog():
        marker=cache.root/'raw'/('restored_'+meta['dataset_id'])
        if marker.exists():continue
        bundle=cache.load(meta['dataset_id']);validate_tables(bundle);service=meta['service']
        registry={h:g[['operator','owner']].values.tolist() for h,g in bundle['registry'].groupby('height')}
        for point in bundle['schedule'].to_dict('records'):
            h=point['height']
            cache.get('block',point['scheduled_at'],lambda p=point:{k:p[k] for k in ['height','timestamp','scheduled_at']})
            cache.get('cap',h,lambda p=point:p['cap'])
            cache.get('population',[service,h],lambda h=h:{'height':h,'rows':registry[h],'pages':1})
            apps=sorted(bundle['sessions'].loc[bundle['sessions'].height.eq(h),'application'].unique())
            if meta['config']['app_policy']=='all' or point.get('available_applications')==len(apps):
                cache.get('service_apps',[service,h],lambda a=apps:a)
        members={sid:g[['operator','owner']].values.tolist() for sid,g in bundle['members'].groupby('session_id')}
        claims={sid:g.to_dict('records') for sid,g in bundle['claims'].groupby('sessionId')}
        queries=bundle['payout_queries'].set_index('session_id').to_dict('index')
        for row in bundle['sessions'].to_dict('records'):
            sid=row['session_id'];v={k:row[k] for k in ['height','application','session_id','start_height','end_height']}
            v['selected']=members[sid]
            cache.get('session',[service,row['height'],row['application']],lambda v=v:v)
            query=queries[sid];key=[service,sid]
            if not cache.has('payout',key) or cache.read('payout',key)['cutoff']<query['cutoff']:
                cache.write('payout',key,{**query,'claims':claims.get(sid,[])})
        marker.write_text('Normalized request records restored from frozen tables.\n')



def cache_payout_batches(cache, service, session_ids, cutoff, refresh=False, workers=4):
    """Fetch disjoint payout batches concurrently; pagination within each stays serial.

    Must be called in network_stage. Writes only fully completed queries.
    Published datasets remain immutable even when compact payout records refresh.
    """
    ids=list(dict.fromkeys(session_ids))
    pending=[sid for sid in ids if refresh or not cache.has('payout',[service,sid])]
    batches=[pending[offset:offset+80] for offset in range(0,len(pending),80)]
    def collect(part):
        claims=fetch_claims(service,part,cutoff)
        by_id={sid:[] for sid in part}
        for claim in claims:
            if claim['sessionId'] not in by_id or claim['serviceId']!=service:
                raise ValueError('Indexer returned an unrequested session.')
            by_id[claim['sessionId']].append(claim)
        stamp=datetime.now(timezone.utc).isoformat()
        for sid in part:
            cache.write('payout',[service,sid],{'claims':by_id[sid],'cutoff':cutoff,
                        'fetched_at':stamp,'complete':True})
        return len(part)
    with ThreadPoolExecutor(max_workers=min(4,max(1,workers))) as pool:
        futures=[pool.submit(collect,part) for part in batches]
        return sum(future.result() for future in as_completed(futures))
