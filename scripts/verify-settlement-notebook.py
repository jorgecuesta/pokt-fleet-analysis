#!/usr/bin/env python3
"""Execute the standalone notebook offline in a fresh folder without Jupyter."""
import argparse
import ast
import contextlib
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def verify(path):
    notebook = json.loads(Path(path).read_text(encoding="utf-8"))
    assert notebook["nbformat"] == 4
    assert len({c["id"] for c in notebook["cells"]}) == len(notebook["cells"])
    staged = "pokt_staged_collection" in notebook["metadata"]
    expected_tests=62 if staged else 34
    code_cells = [c for c in notebook["cells"] if c["cell_type"] == "code"]
    assert all(c["execution_count"] is None and not c["outputs"] for c in code_cells)
    for c in code_cells:
        ast.parse("".join(c["source"]))
    for c in notebook["cells"]:
        spec = c["metadata"].get("embedded_module")
        if spec:
            code = "".join(c["source"]).split("\n```python\n", 1)[1].removesuffix("\n```")
            assert code.encode() == (ROOT/spec["path"]).read_bytes(), spec["path"]
            compile(code, spec["path"], "exec")
    original_cwd, original_path = Path.cwd(), sys.path[:]
    output = io.StringIO()
    try:
        with tempfile.TemporaryDirectory(prefix="tmpnotebook-qa-", dir=ROOT) as directory:
            shutil.copyfile(path, Path(directory)/"pokt_settlement_collection.ipynb")
            os.chdir(directory)
            env = {"__name__": "__main__"}
            # Live HTTP in the notebook itself is forbidden in default mode.
            with patch("urllib.request.urlopen", side_effect=AssertionError("Offline notebook attempted HTTP")), contextlib.redirect_stdout(output):
                for i, c in enumerate(code_cells):
                    exec(compile("".join(c["source"]), f"notebook-cell-{i+1}", "exec"), env)
            assert env["MODE"] == "offline" and env["RESULT"] is None
            assert env["checked"].returncode == 0
            assert f"Ran {expected_tests} tests" in env["checked"].stderr
            assert hashlib.sha256((env["WORK_DIR"]/"collector/pokt_live_collector.py").read_bytes()).hexdigest() == "7c0b96b0802b945523a6802ce06bc84124d5ffb4dc2b7b50218e99bdbcc93c27"
            assert not (env["WORK_DIR"]/"cache/responses").exists()
            included = notebook["metadata"]["pokt_staged_collection" if staged else "pokt_settlement"]["pilotIncluded"]
            assert (env["EVIDENCE"] is not None) == included
            if included:
                assert env["RECEIPT"]["status"] == "reconciled"
                assert env["ANALYSIS"]["indexedSettledSessions"] > 0
    finally:
        os.chdir(original_cwd)
        sys.path[:] = original_path
    print(json.dumps({"status": "passed", "codeCells": len(code_cells),
                      "offlineTests": expected_tests, "pilotIncluded": included,
                      "originalCollectorUnchanged": True, "liveRequests": 0}, indent=2))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("notebook", type=Path)
    verify(p.parse_args().notebook)
