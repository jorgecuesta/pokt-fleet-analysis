#!/usr/bin/env python3
"""Rebuild a completed snapshot from local evidence; never makes HTTP requests."""
import argparse
import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pokt_live_collector import VERSION, Client, CACHE_NAMESPACE, digest, assemble, atomic_json, read_json, upgrade_point_registry


class OfflineClient(Client):
    def request(self, url, body=None, height=None, label="http", fresh=False):
        if fresh:
            raise ValueError("Offline rebuilding cannot refresh sources")
        key = digest([CACHE_NAMESPACE, url, body, height, None])
        path = self.root / "responses" / key[:2] / (key+".json.gz")
        if not path.exists():
            raise ValueError(f"Missing original raw registry evidence at height {height}; no network requests are allowed")
        cached = read_json(path)
        if (digest(cached["response"]) != cached["response_sha256"] or cached["requested_height"] != height
                or cached.get("served_height") != str(height)):
            raise ValueError("Original registry checksum or archive height mismatch")
        return cached["response"]


def export(run_dir, catalog_path, output, extension_blocked=False):
    run_dir = Path(run_dir)
    state = read_json(run_dir / "run.json")
    if state["status"] != "complete":
        raise ValueError("Only a fully completed run can become a product snapshot")
    original = read_json(run_dir / "snapshot.json.gz")
    points = sorted((run_dir / "points").glob("*.json.gz"))
    config = state["config"]
    expected = (original["period"]["endExclusive"], original["period"]["start"])
    if expected != (config["endExclusive"], config["start"]):
        raise ValueError("Completed run and original snapshot windows differ")
    claims = read_json(run_dir / "claims.json.gz")
    client = OfflineClient(run_dir.parent.parent)
    structured_points = []
    for path in points:
        part = upgrade_point_registry(read_json(path), client, config["services"])
        structured = run_dir.parent.parent.parent / "evidence" / "structured-pilot" / "points" / path.name
        atomic_json(structured, part)
        structured_points.append(structured)
    snapshot = assemble(structured_points, claims, read_json(catalog_path), config, state["metrics"])
    if snapshot["liveSource"]["coverage"] != original["liveSource"]["coverage"]:
        raise ValueError("Rebuilt coverage differs from completed collection")
    if {s["id"] for s in snapshot["sessions"]} != {s["id"] for s in original["sessions"]}:
        raise ValueError("Rebuilt session identities differ")
    snapshot["generatedAt"] = original["generatedAt"]
    snapshot["liveSource"].update(
        collectorVersion=config["collectorVersion"], processorVersion=VERSION,
        collectedAt=state["completedAt"], processedAt=datetime.now(timezone.utc).isoformat(),
        rosterVerification={"method": "Historical archive REST rosters for every recorded session", "verifiedSessions": len(snapshot["sessions"])},
        evidenceFiles=[{"file": p.relative_to(run_dir).as_posix(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                       for p in [run_dir / "run.json", run_dir / "claims.json.gz", *points]],
    )
    if extension_blocked:
        snapshot["liveSource"]["extension"] = {"requestedDays": 30, "status": "blocked", "reason": "Collection environment network policy blocks Pocket APIs; the completed one-day pilot remains available."}
    ids = {s["id"]: i for i, s in enumerate(snapshot["suppliers"])}
    snapshot["wireCodec"] = "supplier-indices-v1"
    for pop in snapshot["populations"]:
        pop["eligibleSupplierIndices"] = [ids[sid] for sid in pop.pop("eligibleSupplierIds")]
    atomic_json(output, snapshot)
    return snapshot


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--extension-blocked", action="store_true", help="Disclose a separately blocked month extension")
    args = parser.parse_args()
    result = export(args.run, args.catalog, args.output, args.extension_blocked)
    print({"output": args.output, "period": result["period"], "coverage": result["liveSource"]["coverage"]})
