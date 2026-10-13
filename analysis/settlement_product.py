"""Lossless wire packing; does not change a session, membership or amount."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

V1 = "settlement-session-v1"
V2 = "membership-indices-v2"


def pack(evidence):
    if evidence.get("codec") != V1 or "membershipCatalog" in evidence:
        raise ValueError("Expected canonical settlement-session-v1 evidence")
    endpoint_index = {e["id"]: i for i, e in enumerate(evidence["endpointCatalog"])}
    if len(endpoint_index) != len(evidence["endpointCatalog"]):
        raise ValueError("Duplicate endpoint identity")
    catalog, index, sessions = [], {}, []
    for session in evidence["sessions"]:
        members = []
        for supplier, owner, endpoints in session["members"]:
            if (type(supplier) is not int or type(owner) is not int
                    or not 0 <= supplier < len(evidence["supplierIds"])
                    or not 0 <= owner < len(evidence["ownerIds"])):
                raise ValueError("Invalid membership identity index")
            try:
                key = (supplier, owner, tuple(endpoint_index[e] for e in endpoints))
            except KeyError as exc:
                raise ValueError("Unknown membership endpoint") from exc
            if key not in index:
                index[key] = len(catalog)
                catalog.append([supplier, owner, list(key[2])])
            members.append(index[key])
        sessions.append({**session, "members": members})
    return {**evidence, "codec": V2, "membershipCatalog": catalog, "sessions": sessions}


def unpack(evidence):
    if evidence.get("codec") != V2:
        raise ValueError("Expected membership-indices-v2 evidence")
    endpoints = evidence["endpointCatalog"]
    catalog = []
    for supplier, owner, indices in evidence["membershipCatalog"]:
        if (type(supplier) is not int or type(owner) is not int
                or not 0 <= supplier < len(evidence["supplierIds"])
                or not 0 <= owner < len(evidence["ownerIds"])
                or any(type(i) is not int or not 0 <= i < len(endpoints) for i in indices)):
            raise ValueError("Invalid packed membership identity")
        catalog.append([supplier, owner, [endpoints[i]["id"] for i in indices]])
    sessions = []
    for session in evidence["sessions"]:
        if any(type(i) is not int or not 0 <= i < len(catalog) for i in session["members"]):
            raise ValueError("Invalid packed session membership index")
        sessions.append({**session, "members": [catalog[i] for i in session["members"]]})
    return {**{k: v for k, v in evidence.items() if k != "membershipCatalog"},
            "codec": V1, "sessions": sessions}


def export(evidence, path):
    packed = pack(evidence)
    if unpack(packed) != evidence:
        raise ValueError("Lossless product round trip failed")
    raw = json.dumps(packed, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    blob = gzip.compress(raw, mtime=0)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name+".tmp")
    temp.write_bytes(blob)
    temp.replace(path)
    return {"path": str(path), "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
            "codec": V2, "losslessRoundTrip": True,
            "membershipConfigurations": len(packed["membershipCatalog"]),
            "notice": "Lossless packaging only; no website update, eligible-population inference or coverage change."}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    args = p.parse_args()
    evidence = json.loads(gzip.decompress(args.input.read_bytes()))
    print(json.dumps(export(evidence, args.output), indent=2))
