"""Create the compact, exact-overlap reference without changing source data."""
import gzip
import hashlib
import json
from datetime import datetime
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
EXPECTED="feeebfbb120044a782dd60f1879c0613924cb259b7eb528d5f74659055842088"

def at(s):
    return datetime.fromisoformat(s.replace("Z","+00:00"))

def main():
    payload=(ROOT/"data/live-snapshot.json.gz").read_bytes()
    assert hashlib.sha256(payload).hexdigest()==EXPECTED
    data=json.loads(gzip.decompress(payload))
    check=json.loads((ROOT/"data/monthly-claims-diagnostic.json").read_text())
    ids=[s["id"] for s in data["suppliers"]];suppliers={s["id"]:s for s in data["suppliers"]}
    index={sid:i for i,sid in enumerate(ids)}
    owners=sorted({h["ownerId"] for s in data["suppliers"] for h in s["ownerHistory"]})
    owner_index={owner:i for i,owner in enumerate(owners)}
    endpoints={e["id"]:e for e in data["endpointCatalog"]}
    sessions=[]
    for row in data["sessions"]:
        members=[]
        for sid in row["selectedSupplierIds"]:
            supplier=suppliers[sid];date=at(row["startedAt"])
            owner=next(h["ownerId"] for h in supplier["ownerHistory"] if at(h["start"])<=date and (not h["end"] or date<at(h["end"])))
            history=next(h for h in supplier["endpointHistory"] if at(h["start"])<=date and (not h["end"] or date<at(h["end"])))
            endpoint_ids=sorted(eid for eid in history["endpointIds"] if endpoints[eid]["serviceId"]==row["serviceId"])
            members.append([index[sid],owner_index[owner],endpoint_ids])
        payouts=[]
        for p in row["supplierPayouts"]:
            upokt=round(p["pokt"]*1e6)
            assert abs(upokt-p["pokt"]*1e6)<1e-3
            payouts.append([index[p["supplierId"]],str(upokt)])
        sessions.append({"id":row["id"],"serviceId":row["serviceId"],"applicationId":row["applicationId"],
            "observedAt":row["startedAt"],"sessionEndHeight":row["sessionEndHeight"],
            "settledClaimCount":row["settledClaimCount"],"payoutStatus":row["payoutStatus"],
            "members":members,"payouts":payouts})
    reference={"version":"settlement-reference-1.0","snapshotId":data["snapshotId"],"productSha256":EXPECTED,
        "cutoff":data["liveSource"]["cutoff"],"period":data["period"],"supplierIds":ids,"ownerIds":owners,
        "sessions":sessions,"monthlyGroups":[{k:g[k] for k in ("serviceId","applicationId","monthlyClaimCount")} for g in check["groups"]]}
    encoded=json.dumps(reference,separators=(",",":"),sort_keys=True).encode()
    target=ROOT/"collector/settlement-reference.json.gz"
    target.write_bytes(gzip.compress(encoded,mtime=0))
    print(f"Reference: {len(sessions):,} sessions · {target.stat().st_size:,} bytes · original product unchanged")

if __name__=="__main__":main()
