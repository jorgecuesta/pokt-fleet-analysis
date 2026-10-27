"""Build a complete portable notebook; source modules remain readable."""
import argparse
import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT
OUT = ROOT/'notebooks/pokt_settlement_collection.ipynb'
PACKAGE_ID = 'pokt-staged-settlement-20261013'
MODULES = ['collector/pokt_live_collector.py', 'collector/session_catalog.py', 'collector/settlement_collect.py', 'collector/staged_collection.py',
           'analysis/settlement_analysis.py', 'analysis/settlement_product.py', 'tests/test_settlement.py', 'tests/test_staged.py']
ASSETS = ['collector/public_suffix_list.dat', 'collector/settlement-reference.json.gz',
          'tests/fixtures/settlement-catalog-roster.json.gz', 'tests/fixtures/settlement-chain-events.json.gz',
          'reviewed-pilot/result.json', 'reviewed-pilot/settlement-evidence.json.gz']


def cell(kind, source, **meta):
    data = {'cell_type': kind, 'id': hashlib.sha256((kind+source).encode()).hexdigest()[:12],
            'metadata': meta, 'source': source.splitlines(True)}
    if kind == 'code':
        data.update(execution_count=None, outputs=[])
    return data


def main():
    cells = [cell('markdown', '''# Fleet Observatory: collect, investigate, then scale

**One notebook. Start offline, then 7 → 14 → 30 days.** All collection code is readable in the appendices and embedded here; no companion download is needed.

Think of two books: **attendance** tells us who was selected; **payment receipts** tell us what distributions were recorded. The existing website has a completed 30-day attendance/session sample. Its payout evidence covers **1,652 of 4,080 sampled sessions (40.5%)**. Nineteen of the 34 observed Application/service groups had no indexed monthly settlements at the fixed cutoff. Those absent outcomes remain unknown.

This notebook expands the **payment-receipt book** and investigates one covered and one uncovered Ethereum Application group. It does not silently turn unknown sessions into zero or overwrite the website. Collected earnings are explicitly conditional on **indexed settled sessions**, not all requests, all network activity or guaranteed actual income.

The source is the published fleet analyser commit `fc0eb630771b96e157caa38cd687f867dc152dd2`. Its original HTTP/endpoint collector and proved settlement collector are included **unchanged**. The staged runner and on-chain investigation are new.
'''), cell('markdown', '''## 1. Start here

1. Make a dedicated folder such as `C:\\Users\\mwil8\\Documents\\pokt-staged-collection`. Save this notebook there. Keep one copy in that folder.
2. Open it in your existing Jupyter installation. Python **3.10 or newer** works; your existing Python 3.12 is suitable. This notebook needs no extra packages, wallet, API key, Node.js, GitHub or Vercel setup.
3. Leave `MODE = "offline"` below. Select **Run → Run All Cells**. Expected: the source integrity checks and **62 tests pass**, the included reviewed Ethereum pilot appears, and no live requests are made. Offline execution should normally take seconds; folder location does not speed up remote API calls.
4. Save the notebook. Change only MODE to `"7d"`, then run all cells. By default this reuses the successful Ethereum proof and runs the new paired live investigation, rather than downloading the same pilot again.
5. Inspect the investigation output. If its technical status is `passed`, move to `"14d"`, then finally `"30d"` after the 14-day receipt says `reconciled`. Each later stage checks its prerequisites before starting HTTP. If a source discrepancy or access error appears, keep MODE at the failing stage and send the generated `review-results.zip` here.

**Use one collector at a time.** Keep the computer awake for live stages. The eight-service 14- and 30-day runs can take hours: these download all indexed settlements and check every historical settled-session roster, rather than taking four daily samples. A heartbeat prints real checkpoint progress every 30 seconds.

The work folder is `pokt-staged-work` beside the notebook. Keep it between runs. Interrupt a live cell only once, wait for it to stop, and rerun the same mode to resume. A forced kernel crash can leave a lock; its error explains which file to remove after confirming no collector is still running.

If you already have the earlier settlement cache or extracted checkpoint, set CACHE_ROOT_OVERRIDE to its exact `cache` folder. **Do not select the original sampled-collection cache.** The 30-day stage uses the original monthly plan/run ID, retaining compatible saved claims; shared historical HTTP requests also remain reusable. The 14-day claim query has a different window, so its payout pages may need fetching separately.
'''), cell('code', '''from pathlib import Path
import sys

MODE = "offline"          # "offline", "investigate", "7d", "14d", "30d"
NOTEBOOK_PATH = None       # set the full notebook path only if automatic discovery fails
CACHE_ROOT_OVERRIDE = None # optionally Path(r"C:\\...\\pokt-settlement-work\\cache")
REUSE_INCLUDED_PILOT = True
MAKE_REVIEW_ZIP = True     # creates a local review file; nothing is sent or published

if sys.version_info < (3, 10):
    raise RuntimeError("Python 3.10+ is required; Python 3.12 is suitable.")
if MODE not in {"offline", "investigate", "7d", "14d", "30d"}:
    raise ValueError("Choose offline, investigate, 7d, 14d or 30d")
print("Python:", sys.version.split()[0], "· MODE:", MODE)
print("Jupyter working folder:", Path.cwd())
'''), cell('markdown', '''## 2. Verify and unpack the exact code

The complete Python source is shown at the end. The suffix list, frozen overlap reference, parser fixtures and verified pilot are stored in notebook metadata to keep ordinary cells short. Setup checks SHA-256 values and preserves exact bytes on Windows. A locally edited source file is kept and triggers a clear integrity error; use a fresh work folder rather than silently overwriting it.
'''), cell('code', '''import base64
import hashlib
import json

PACKAGE_ID = "pokt-staged-settlement-20261013"
if NOTEBOOK_PATH is None:
    candidates = []
    for candidate in Path.cwd().glob("pokt*collection*.ipynb"):
        try:
            saved = json.loads(candidate.read_text(encoding="utf-8"))
            if saved.get("metadata", {}).get("pokt_staged_collection", {}).get("packageId") == PACKAGE_ID:
                candidates.append(candidate)
        except (ValueError, OSError):
            pass
    if len(candidates) != 1:
        raise FileNotFoundError("Set NOTEBOOK_PATH to this saved notebook's full path, then rerun all cells.")
    NOTEBOOK_PATH = candidates[0]
NOTEBOOK_PATH = Path(NOTEBOOK_PATH).expanduser().resolve()
notebook = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
metadata = notebook["metadata"]["pokt_staged_collection"]
if metadata["packageId"] != PACKAGE_ID:
    raise ValueError("Wrong notebook edition")
WORK_DIR = NOTEBOOK_PATH.parent/"pokt-staged-work"
WORK_DIR.mkdir(parents=True, exist_ok=True)

def materialise(relative, data, expected):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Embedded checksum mismatch: " + relative)
    target = (WORK_DIR/relative).resolve()
    if WORK_DIR.resolve() not in target.parents:
        raise ValueError("Invalid embedded path")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != expected:
        raise FileExistsError("Local source differs: " + str(target) + ". Keep your edits and use a fresh notebook folder.")
    if not target.exists():
        target.write_bytes(data)

for item in notebook["cells"]:
    spec = item.get("metadata", {}).get("embedded_module")
    if spec:
        code = "".join(item["source"]).split("\\n```python\\n", 1)[1].removesuffix("\\n```")
        materialise(spec["path"], code.encode("utf-8"), spec["sha256"])
for relative, asset in metadata["assets"].items():
    materialise(relative, base64.b64decode(asset["base64"], validate=True), asset["sha256"])
CACHE_ROOT = Path(CACHE_ROOT_OVERRIDE).expanduser().resolve() if CACHE_ROOT_OVERRIDE is not None else WORK_DIR/"cache"
print("Work folder:", WORK_DIR)
print("Cache folder:", CACHE_ROOT)
print("Published source:", metadata["sourceCommit"])
print("Included verified pilot: Ethereum · 7 days · 26,888 claims · 1,327 sessions")
'''), cell('markdown', '''## 3. Run the offline checks

The tests cover exact payments, unknown outcomes, pagination, timeout handling, resume, historical memberships, lossless packing, stage prerequisites and real ABCI event parsing. They also test that an on-chain/indexer discrepancy blocks expansion and that a negative small probe never becomes a whole-group zero.

These checks validate the code. They do not establish fresh live API access or complete network coverage.
'''), cell('code', '''import subprocess

checked = subprocess.run(
    [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
    cwd=WORK_DIR, capture_output=True, text=True, timeout=120,
)
print(checked.stdout)
print(checked.stderr)
if checked.returncode:
    raise RuntimeError("Offline checks failed. Save this output before running a live mode.")
'''), cell('markdown', '''## 4. Understand the stages

| MODE | Exact UTC session-end window | Services | What happens |
|---|---|---|---|
| `offline` | Included proof only | Ethereum | Tests and reviews existing evidence; no HTTP |
| `investigate` | 29 September–5 October 2026 | Ethereum | Runs only the paired source investigation |
| `7d` | 29 September–5 October 2026 | Ethereum | Reuses or reproduces the seven-day proof, then investigates |
| `14d` | 22 September–5 October 2026 | All eight | Collects and reconciles a fortnight after the seven-day gates |
| `30d` | 6 September–5 October 2026 | All eight | Collects the full month after the fortnight gate |

All stages preserve the original fixed settlement cutoff **955,836**, eight-service choice and protocol interpretation. The month remains September 6 through October 5, not a new rolling month. We are fetching historical records, so no waiting for future days is necessary.

Each service includes all indexed Applications. Payout pagination counts before/after, records pages atomically and checks duplicates. Supplier income uses **relay/global Supplier-shareholder distribution reasons**, not the whole claim value, with exact integer uPOKT. Every settled session has its authoritative historical selected roster, owner and service-specific endpoints verified.

The investigation compares three covered/uncovered session pairs at the same historical end heights. It checks the covered claims' exact Supplier distributions against real on-chain events and looks for uncovered-group events in those same settlement blocks. It also compares the group's seven-day counts at the original and a separately recorded later cutoff.

**Limits:** the live probe is capped at twelve RPC blocks. A positive mismatch can establish an indexer discrepancy. Finding no payments in these checked blocks cannot certify every session in a group or prove no traffic. A technically successful investigation permits collection of the explicitly limited indexed-settlement universe; the original broader unknown outcomes remain unknown.

Reference sources: [Pocket sessions, claims and proofs](https://docs.pocket.network/protocol/sessions-claims-proofs/) and [tokenomics](https://docs.pocket.network/protocol/tokenomics-deep-dive/). Actual event parsing is replay-tested against an existing recorded block. Current documentation's live parameter values are not substituted for historical settings.
'''), cell('code', '''sys.path.insert(0, str(WORK_DIR/"collector"))
sys.path.insert(0, str(WORK_DIR/"analysis"))
# A different notebook opened earlier in this kernel must not supply stale modules.
for name in ("staged_collection", "settlement_collect", "session_catalog", "pokt_live_collector", "settlement_analysis", "settlement_product"):
    loaded = sys.modules.get(name)
    if loaded and WORK_DIR.resolve() not in Path(loaded.__file__).resolve().parents:
        del sys.modules[name]
import staged_collection as staged
from pokt_live_collector import atomic_json, read_json
from settlement_analysis import analyze
from settlement_product import export as export_product

REFERENCE_PATH = WORK_DIR/"collector/settlement-reference.json.gz"
INCLUDED_PILOT = WORK_DIR/"reviewed-pilot/result.json"
PILOT_REPORT = INCLUDED_PILOT if REUSE_INCLUDED_PILOT else staged.run_dir(CACHE_ROOT, "7d")/"result.json"
included = staged.verify_receipt(INCLUDED_PILOT, "7d")
print("Included proof checksum and scope: PASS")
if MODE in {"7d", "14d", "30d"}:
    print(json.dumps(staged.plan(MODE), indent=2))
    print("Stage work:", staged.run_dir(CACHE_ROOT, MODE))
print("Original sampled payout coverage stays:", "1,652 / 4,080 · 40.5%")
'''), cell('markdown', '''## 5. Run the selected mode, or resume it

This is the live cell. Leave it running until it finishes or returns an error. In offline mode it makes no requests. The seven-day default reuses the included proof; set REUSE_INCLUDED_PILOT to False only if you want to reproduce that proof yourself.

Long live stages print downloaded claims and verified historical rosters every 30 seconds. A flat count can mean a slow request is pending. Changing folder does not fix a busy API. Requests have bounded retries; HTTP 429 means rate limiting, HTTP 403 may be an access restriction, and a transport timeout means the request did not finish in time. HTTP 200 can still contain GraphQL errors.

The previous monthly run encountered PostgreSQL statement timeout **57014**. The included collector avoids repeating expensive whole-window counts in each payout page and retries that specific timeout at the same cursor with smaller pages. Other schema/semantic errors stop. Counts still reconcile separately. Keep the exact error, rather than filling unknown amounts or changing dates to pass.

Errors are saved in a concise local file and the notebook continues to the review export. A failed stage does not create a successful new receipt. The next stage checks actual artifact bytes and prerequisites before starting collection.
'''), cell('code', '''RESULT = None
LAST_ERROR = None

def progress(message):
    print(message, flush=True)

if MODE == "offline":
    print("OFFLINE: no live requests. Reviewing the included proof only.")
else:
    try:
        RESULT = staged.execute(MODE, CACHE_ROOT, REFERENCE_PATH, PILOT_REPORT,
                                reuse_pilot=REUSE_INCLUDED_PILOT, progress=progress)
        print("Selected mode returned:", MODE)
    except Exception as exc:
        LAST_ERROR = {"mode": MODE, "type": type(exc).__name__, "message": str(exc)}
        atomic_json(WORK_DIR/"last-error.json", LAST_ERROR)
        print("STOPPED:", LAST_ERROR["type"], LAST_ERROR["message"])
        print("Keep the work folder. Save this notebook and share review-results.zip before changing stage.")
'''), cell('markdown', '''## 6. Read the investigation separately from collection

`passed` means the paired technical checks passed for their stated scope. It does not mean every Application's missing payments were explained. An indexer discrepancy, a changed original-cutoff reference, an unavailable RPC archive or a control mismatch produces `needs_review` and blocks the later stages.

If no uncovered events were found, we retain that limited observation and the unresolved whole-group question. A larger group-wide chain reconciliation or a different reliable source may be needed. This notebook makes that distinction visible instead of declaring 100% network coverage.
'''), cell('code', '''DIAGNOSIS = None
diagnosis_path = CACHE_ROOT/"investigation/result.json"
if RESULT and RESULT.get("investigation") is not None:
    DIAGNOSIS = RESULT["investigation"]
elif diagnosis_path.is_file():
    DIAGNOSIS = read_json(diagnosis_path)
    print("Showing the saved investigation:", DIAGNOSIS.get("completedAt"))
if DIAGNOSIS is None:
    print("No live missing-payment investigation yet. MODE=7d runs it next.")
else:
    print("Technical status:", DIAGNOSIS["technicalStatus"])
    print(DIAGNOSIS["missingPaymentFinding"])
    print("Whole-group cause established:", DIAGNOSIS["wholeGroupCauseEstablished"])
    print("Later cutoff (separate from the product):", DIAGNOSIS.get("laterCutoff"))
    for group in DIAGNOSIS["groups"]:
        print(group["kind"], "·", group["applicationId"],
              "· original-cutoff claims:", group["originalCutoffClaims"],
              "· later-cutoff claims:", group["laterCutoffClaims"])
    for error in DIAGNOSIS["errors"]:
        print("SOURCE ERROR:", error["type"], error["message"])
    print(DIAGNOSIS["scopeNotice"])
'''), cell('markdown', '''## 7. Inspect verified recorded earnings

The **offline view is the included reviewed pilot**, not a newly completed local collection. Live evidence appears here only when the selected collection returns a reconciled receipt with matching artifact bytes.

Choose owner, domain or Supplier below. Owner groups follow recorded historical ownership. Domain groups follow service-specific endpoint associations and may overlap; they do not prove a common business. Counts refer to Suppliers selected in these settled sessions, not a fleet's entire registered size.

F is **gross indexed Supplier distributions ÷ equal share of the same sessions' Supplier pool**. F=1 means equal share; F=1.2 means 20% above that reference. It is not profit, uptime or an automatic prediction. Predictions require enough relevant earlier/later evidence, assessed separately during product integration.
'''), cell('code', '''DIMENSION = "owner"       # "owner", "domain", "supplier"
SERVICE = None             # None combines collected services; or "eth", "base", etc.
EVIDENCE = None
RECEIPT = None
ANALYSIS = None
RECEIPT_PATH = None
if MODE == "offline":
    RECEIPT_PATH = INCLUDED_PILOT
    print("INCLUDED REVIEWED PILOT: Ethereum, seven days. No fresh collection performed.")
elif RESULT and RESULT.get("receiptPath"):
    RECEIPT_PATH = Path(RESULT["receiptPath"])
if RECEIPT_PATH is not None:
    receipt_mode = "7d" if MODE == "offline" else MODE
    RECEIPT = staged.verify_receipt(RECEIPT_PATH, receipt_mode)
    EVIDENCE = read_json(RECEIPT_PATH.parent/RECEIPT["artifact"])
    ANALYSIS = analyze(EVIDENCE, DIMENSION, SERVICE)
    print(json.dumps({k: RECEIPT[k] for k in ("status", "config", "coverage", "overlap")}, indent=2))
    print(ANALYSIS["notice"])
    import html
    columns = ["label", "actualPokt", "equalSharePokt", "fScore", "differencePercent", "selectedSupplierIdentities", "informativeDays"]
    headers = ["Historical group", "Gross POKT", "Equal-share POKT", "F", "vs equal share (%)", "Selected Supplier IDs", "Informative days"]
    def shown(value):
        return "—" if value is None else f"{value:,.3f}" if isinstance(value, float) else str(value)
    table = '<div style="overflow:auto"><table><thead><tr>' + ''.join('<th>'+h+'</th>' for h in headers) + '</tr></thead><tbody>'
    for row in ANALYSIS["rows"][:20]:
        table += '<tr>'+''.join('<td>'+html.escape(shown(row[c]))+'</td>' for c in columns)+'</tr>'
    table += '</tbody></table></div>'
    try:
        from IPython.display import HTML, display
        display(HTML(table))
    except ImportError:
        for row in ANALYSIS["rows"][:20]:
            print({c: row[c] for c in columns})
    print("Showing up to 20 groups. The JSON export keeps every group. This proof analysis assigns no ranks.")
else:
    print("No successfully reconciled receipt for the selected mode. An investigation alone is not a collection.")
'''), cell('markdown', '''## 8. Save the result and the review package

This writes a clear readiness report, complete group analysis, lossless compact product and a local review ZIP. Packing checks a full round trip before saving; no observation, historical configuration or amount is dropped. The ZIP includes readable code, reference, completed stage receipts/evidence and the investigation/error report. It excludes raw HTTP responses and the large SQLite databases.

Save the notebook with **File → Save Notebook**. Attach the saved notebook and `review-results.zip` **in this conversation**. Nothing is sent to Ramiro or deployed. We will review the source question and data, then update the website and assess fleet-specific historical tests before public GitHub/Vercel setup.
'''), cell('code', '''import zipfile

readiness = staged.readiness(RECEIPT, DIAGNOSIS)
readiness.update(mode=MODE, lastError=LAST_ERROR, sourceCommit=metadata["sourceCommit"])
atomic_json(WORK_DIR/"readiness-report.json", readiness)
atomic_json(WORK_DIR/"source-provenance.json", {"sourceCommit": metadata["sourceCommit"], "packageId": PACKAGE_ID,
             "modules": metadata["modules"], "assetHashes": {k:v["sha256"] for k,v in metadata["assets"].items()}})
print(json.dumps(readiness, indent=2))
if ANALYSIS is not None:
    atomic_json(WORK_DIR/"recorded-earnings-analysis.json", ANALYSIS)
if EVIDENCE is not None:
    packed = export_product(EVIDENCE, WORK_DIR/"indexed-settlements-product.json.gz")
    print("Lossless product:", packed["path"], "·", packed["bytes"], "bytes · exact round trip passed")
if MAKE_REVIEW_ZIP:
    paths = {relative: WORK_DIR/relative for relative in metadata["modules"]}
    paths.update({relative: WORK_DIR/relative for relative in metadata["assets"]})
    for name in ("readiness-report.json", "source-provenance.json", "last-error.json", "recorded-earnings-analysis.json", "indexed-settlements-product.json.gz"):
        if name == "last-error.json" and LAST_ERROR is None:
            continue
        if name in {"recorded-earnings-analysis.json", "indexed-settlements-product.json.gz"} and EVIDENCE is None:
            continue
        if (WORK_DIR/name).is_file():
            paths[name] = WORK_DIR/name
    if diagnosis_path.is_file():
        paths["investigation/result.json"] = diagnosis_path
    for mode in ("7d", "14d", "30d"):
        directory = staged.run_dir(CACHE_ROOT, mode)
        for name in ("run.json", "result.json", "settlement-evidence.json.gz"):
            if (directory/name).is_file():
                paths[f"stages/{mode}/{name}"] = directory/name
    review_zip = WORK_DIR/"review-results.zip"
    temporary = review_zip.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, path in sorted(paths.items()):
            archive.write(path, name)
    temporary.replace(review_zip)
    print("REVIEW ZIP:", review_zip)
    print("Size:", f"{review_zip.stat().st_size/1048576:.1f} MiB", "· raw HTTP and SQLite excluded")
if LAST_ERROR:
    print("NEXT: save the notebook and share its review ZIP; keep the current stage and cache.")
elif MODE in {"7d", "investigate"}:
    print("NEXT:", '14d is permitted for indexed-settlement collection.' if DIAGNOSIS and DIAGNOSIS["technicalStatus"] == "passed" else 'Share the investigation report before expansion.')
elif MODE == "14d" and RECEIPT:
    print('NEXT: MODE="30d" may now collect the fixed full month.')
elif MODE == "30d" and RECEIPT:
    print("NEXT: share this notebook and review ZIP here for data review and product integration.")
else:
    print('NEXT: save the notebook, set MODE="7d", and run all cells.')
'''), cell('markdown', '''## Source appendices

These are the exact readable modules used by the executable cells. No hidden library supplies the collection logic. The original two collectors remain unchanged; `staged_collection.py` adds the paired investigation, 14-day orchestration, stage gates and progress heartbeat. The tiny on-chain fixture contains exact selected events from a previously recorded block and is only a parser test, rather than complete live source evidence.
''')]
    modules = {}
    for path in MODULES:
        raw = (PACKAGE/path).read_bytes()
        modules[path] = hashlib.sha256(raw).hexdigest()
        cells.append(cell('markdown', f'### {path}\n\n```python\n'+raw.decode('utf-8')+'\n```',
                          embedded_module={'path': path, 'sha256': modules[path]}))
    assets = {}
    for path in ASSETS:
        source=PACKAGE/path
        if path.startswith('reviewed-pilot/'):
            source=PACKAGE/'data/settlement-pilot'/Path(path).name
        raw = source.read_bytes()
        assets[path] = {'sha256': hashlib.sha256(raw).hexdigest(), 'base64': base64.b64encode(raw).decode('ascii')}
    notebook = {'nbformat': 4, 'nbformat_minor': 5, 'metadata': {
        'kernelspec': {'display_name': 'Python 3 (ipykernel)', 'language': 'python', 'name': 'python3'},
        'language_info': {'name': 'python', 'version': '3.10+'},
        'pokt_staged_collection': {'packageId': PACKAGE_ID, 'sourceCommit': 'fc0eb630771b96e157caa38cd687f867dc152dd2',
                                   'modules': modules, 'assets': assets, 'pilotIncluded': True, 'offlineTests': 65}},
        'cells': cells}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(notebook, ensure_ascii=False, indent=1)+'\n', encoding='utf-8')
    print(json.dumps({'notebook': str(OUT), 'bytes': OUT.stat().st_size, 'codeCells': sum(c['cell_type']=='code' for c in cells),
                      'sourceModules': len(modules), 'pilotIncluded': True}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=OUT)
    OUT=parser.parse_args().output
    main()
