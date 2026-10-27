#!/usr/bin/env python3
"""Collect 30 complete UTC days for the eight reviewed services.

Run on a machine with normal Pocket API access. This script is a runner, not a
hosted refresh service. --dry-run makes no HTTP requests. A failed collection
leaves the existing product untouched and retains its exact resumable run.json.
"""
import argparse
import hashlib
import json
import os
from datetime import timedelta
from pathlib import Path

from pokt_live_collector import Client, FIXED_SERVICES, VERSION, collect, digest, discover, dt, read_json, suffix_rules


def validate_month(snapshot):
    if snapshot.get("dataKind") != "live":
        raise ValueError("Only recorded live evidence can replace the product")
    if set(s["id"] for s in snapshot["services"]) != set(FIXED_SERVICES):
        raise ValueError("Monthly snapshot must retain the eight reviewed services")
    start,end = dt(snapshot["period"]["start"]),dt(snapshot["period"]["endExclusive"])
    if end-start != timedelta(days=30) or any((date.hour,date.minute,date.second,date.microsecond)!=(0,0,0,0) for date in (start,end)):
        raise ValueError("Monthly snapshot must cover exactly 30 complete UTC days")
    expected={(service,(start+timedelta(days=day,hours=hour)).isoformat().replace("+00:00","Z"))
              for service in FIXED_SERVICES for day in range(30) for hour in (3,9,15,21)}
    observed=[(p["serviceId"],p["scheduledAt"]) for p in snapshot["populations"]]
    if len(observed)!=len(expected) or set(observed)!=expected:
        raise ValueError("Missing or duplicated service observations in the monthly sampling frame")
    if any("endpointIds" not in h for s in snapshot["suppliers"] for h in s["endpointHistory"]):
        raise ValueError("Monthly endpoints must preserve service-specific history")
    source=snapshot["liveSource"]
    if source["coverage"]["samplePoints"] != 120:
        raise ValueError("Monthly source must confirm all 120 observation points")
    per_service=[]
    for service in FIXED_SERVICES:
        sessions=[s for s in snapshot["sessions"] if s["serviceId"]==service]
        covered=sum(s["payoutStatus"]=="complete" for s in sessions)
        unknown=[s for s in sessions if s["payoutStatus"]!="complete"]
        per_service.append({"serviceId":service,"sessions":len(sessions),"comparableSessions":covered,
                            "unknownSessions":len(unknown),"payoutCoverage":covered/len(sessions) if sessions else None,
                            "unknownWithoutIndexedClaims":sum(not s.get("settledClaimCount") for s in unknown),
                            "unknownWithUnverifiedClaims":sum(bool(s.get("settledClaimCount")) for s in unknown)})
    return {"status":"complete", "days":30, "services":FIXED_SERVICES,
            "samplePoints":120, "serviceObservations":len(observed), "cutoff":source["cutoff"],
            "coverage":source["coverage"], "endpointParsing":source["endpointParsing"],
            "perServicePayoutEvidence":per_service,
            "notice":"Unknown payouts remain unknown. Complete collection does not guarantee adequate earnings evidence."}


def resume_catalogue(resume, cache_root):
    """Use a run-pinned catalogue, or the matching legacy cache-root catalogue."""
    config=read_json(resume)["config"]
    candidates=[resume.parent/"catalog.json",cache_root/"catalog.json"]
    path=next((p for p in candidates if p.exists()),None)
    if path is None:
        raise ValueError("Resume requires the original saved catalogue; do not refresh the cutoff")
    catalogue=read_json(path)
    if catalogue["cutoff"]!=config["cutoff"] or catalogue["endExclusive"]!=config["endExclusive"]:
        raise ValueError("Resume catalogue differs from the original fixed cutoff or end date")
    return catalogue


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out",type=Path,default=Path("pokt-live-cache"))
    parser.add_argument("--resume",type=Path,help="Exact prior 30-day run.json; preserves services, window and cutoff")
    parser.add_argument("--end",help="UTC exclusive end date, otherwise use the current mature cutoff")
    parser.add_argument("--cutoff",type=int,help="Fixed indexer height, to reproduce an earlier collection; default the latest")
    parser.add_argument("--workers",type=int,choices=range(1,5),default=2)
    parser.add_argument("--product-output",type=Path,default=Path("data/live-snapshot.json.gz"))
    parser.add_argument("--dry-run",action="store_true")
    args=parser.parse_args()
    if args.resume and (args.end or args.cutoff):
        parser.error("A resumed run keeps its original end date and cutoff")
    plan={"collectorVersion":VERSION, "days":30,"services":FIXED_SERVICES,"hoursUTC":[3,9,15,21],
          "settlementBufferDays":2,"workers":args.workers,"output":str(args.product_output),
          "resume":str(args.resume) if args.resume else None,"endExclusive":args.end or "latest mature UTC boundary",
          "cutoff":args.cutoff or "latest indexed height"}
    if args.resume:
        state=read_json(args.resume);config=state["config"]
        if (set(config["services"])!=set(FIXED_SERVICES) or dt(config["endExclusive"])-dt(config["start"])!=timedelta(days=30)
                or config["hours"]!=[3,9,15,21]):
            parser.error("Resume requires the fixed eight-service, 30-day sampling frame")
        if args.resume.parent.resolve() != (args.out/"runs"/digest(config)[:16]).resolve():
            parser.error("--out must be the transferred cache root containing this exact run directory")
        catalog=resume_catalogue(args.resume,args.out)
        plan.update(start=config["start"],endExclusive=config["endExclusive"],cutoff=config["cutoff"])
        plan["retainedPointFiles"]=len(list((args.resume.parent/"points").glob("*.json.gz")))
    print(json.dumps(plan,indent=2),flush=True)
    suffix_rules()  # Verify the local PSL before collecting anything.
    if args.dry_run:
        return
    client=Client(args.out,args.workers)
    if not args.resume:
        catalog=discover(client,args.end,max_services=8,target=.95,cutoff=args.cutoff)
    snapshot=collect(client,catalog,30,FIXED_SERVICES,args.resume)
    audit=validate_month(snapshot)
    state=read_json(args.out/"latest.json")
    product=Path(state["snapshotPath"]).with_name("product-snapshot.json.gz")
    payload=product.read_bytes()
    args.product_output.parent.mkdir(parents=True,exist_ok=True)
    temporary=args.product_output.with_name(args.product_output.name+".tmp")
    temporary.write_bytes(payload)
    os.replace(temporary,args.product_output)
    audit["productSha256"]=hashlib.sha256(payload).hexdigest()
    args.product_output.with_name("monthly-collection-audit.json").write_text(json.dumps(audit,indent=2)+"\n")
    print(json.dumps(audit,indent=2),flush=True)


if __name__ == "__main__":
    main()
