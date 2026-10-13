"""Exact integer/Fraction totals for the separate indexed-settlement universe."""
from collections import defaultdict
from fractions import Fraction


def analyze(evidence, dimension="owner", service_id=None):
    if evidence.get("codec")!="settlement-session-v1" or dimension not in {"owner","domain","supplier"}:
        raise ValueError("Use the verified settlement codec and a supported identity dimension")
    suppliers=evidence["supplierIds"];owners=evidence["ownerIds"]
    endpoints={e["id"]:e for e in evidence["endpointCatalog"]}
    sessions=[s for s in evidence["sessions"] if service_id is None or s["serviceId"]==service_id]
    rows={};covered=sum(s["payoutStatus"]=="verified" for s in sessions)
    unassigned=0
    for session in sessions:
        if len(session["members"])!=session["selectedCount"] or len({m[0] for m in session["members"]})!=len(session["members"]):
            raise ValueError("Selected membership does not reconcile with K")
        groups=defaultdict(set)
        for supplier,owner,endpoint_ids in session["members"]:
            if dimension=="owner":labels={owners[owner]}
            elif dimension=="supplier":labels={suppliers[supplier]}
            else:
                labels={endpoints[e]["registrableDomain"] for e in endpoint_ids if endpoints[e]["registrableDomain"]}
                if not labels:unassigned+=1
            for label in labels:groups[label].add(supplier)
        if session["payoutStatus"]=="verified":
            payouts={i:int(v) for i,v in session["payouts"]};pool=int(session["poolUpokt"])
            if sum(payouts.values())!=pool or not set(payouts).issubset({m[0] for m in session["members"]}):
                raise ValueError("Session pool or attributed distributions do not reconcile")
        else:
            if session["poolUpokt"] is not None or session["payouts"]:
                raise ValueError("Unknown payout cannot be filled with an amount")
        for label,selected in groups.items():
            row=rows.setdefault(label,{"label":label,"actualUpokt":0,"reference":Fraction(0),"selectedSupplierIndices":set(),
                "selectedPositions":0,"positiveSessions":0,"informativeDates":set()})
            row["selectedSupplierIndices"].update(selected);row["selectedPositions"]+=len(selected)
            if session["payoutStatus"]=="verified":
                row["actualUpokt"]+=sum(v for i,v in payouts.items() if i in selected)
                row["reference"]+=Fraction(pool*len(selected),session["selectedCount"])
                if pool>0:row["positiveSessions"]+=1;row["informativeDates"].add(session["endedAt"][:10])
    result=[]
    for row in rows.values():
        ref=row.pop("reference");f=float(Fraction(row["actualUpokt"],1)/ref) if ref else None
        row.update(actualUpokt=str(row["actualUpokt"]),actualPokt=int(row["actualUpokt"])/1e6,
            equalSharePokt=float(ref)/1e6,equalShareUpokt={"numerator":str(ref.numerator),"denominator":str(ref.denominator)},
            fScore=f,differencePercent=(f-1)*100 if f is not None else None,
            selectedSupplierIdentities=len(row.pop("selectedSupplierIndices")),informativeDays=len(row.pop("informativeDates")))
        result.append(row)
    return {"dimension":dimension,"serviceId":service_id,"rows":sorted(result,key=lambda r:(-int(r["actualUpokt"]),r["label"])),
        "indexedSettledSessions":len(sessions),"verifiedDistributionSessions":covered,
        "indexedSessionCoverage":covered/len(sessions) if sessions else None,
        "overlapping":dimension=="domain","positionsWithoutRegistrableDomain":unassigned,
        "notice":"Conditional on indexed settled sessions; no registered-session presence or network population is inferred. Domain groups may overlap. Ranks are not assigned by this proof analysis."}
