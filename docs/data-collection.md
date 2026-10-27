# Collection, evidence and next data work

Updated 13 October 2026. The original-sample sections below describe the first collection; the completed separate settlement collection is summarised at the end. The current product is the completed month supplied from the user's accessible machine, re-collected from the pocketdex session catalog on 27 October 2026 (see [Sources](#sources-since-27-october-2026)). The app reads a saved snapshot, with no browser API requests or automatic refresh.

## The completed frame

| Setting | Value |
|---|---|
| Observation window | 6 September–5 October 2026, inclusive, UTC |
| Exclusive end | 6 October 2026, 00:00 UTC |
| Fixed indexer cutoff | 955836 |
| Services | arb-one, base, bsc, eth, opbnb, poly, robinhood, solana |
| Sampling hours | 03, 09, 15, 21 UTC daily |
| Frame | 120 shared points × 8 services = 960 service observations |
| Applications | All historically eligible; 34 observed Application/service groups |
| Supplier identities / historical owners | 4,500 / 198 |
| Service-specific endpoints | 6,698, including one explicitly invalid endpoint |
| Sessions / settled Supplier claims | 4,080 / 47,880 |
| Comparable / unknown sessions | 1,652 / 2,428 |
| Unverified returned payout claims | 0 |
| Product checksum | feeebfbb120044a782dd60f1879c0613924cb259b7eb528d5f74659055842088 |

The eight-service budget was chosen before inspecting fleet earnings. The original seven-day screen listed 264 registered service metadata entries; the selected services covered 86.1% of indexed settled estimated compute units, below the intended 95% target. That screening-week share does not measure all traffic or this month's traffic. The fixed list preserves the cohort while completing the backfill.

This frame samples one historical session per eligible Application/service at each observation. It is not an all-session census, full traffic measurement or monthly-income calculation. Gross Supplier distributions can include revenue-share recipients and do not equal owner profit.

## Collection pipeline

1. Screen services and freeze the mature end boundary, indexer cutoff and catalogue.
2. Resolve each observation timestamp to an archive block and historical shared/service parameters.
3. Read the staked Suppliers once per shared point, as staked before the start of the session covering it; read the sessions covering the point and their rosters from the session catalog. Every eligible population must equal the sessions' candidate count.
4. Preserve historical owner membership and service-specific endpoints. Parse account/URL components, retaining the pinned suffix list, hashes, literal labels and invalid records.
5. Deduplicate sampled sessions; each roster member that was paid or settled for zero is one settled claim, with its Supplier-shareholder payout. HTTP success still requires source/product validation.
6. Write the compact product only after all monthly observations pass. Unknown outcomes remain explicit. Produce the audit and retain the raw cache separately.

The local invocation recorded **550 HTTP attempts, 1,120,869,894 received response bytes and 1,105.91 seconds** (about 18 minutes 26 seconds). These describe that invocation, not a future benchmark. The supplied log contains 558 HTTP 200 records: eight diagnostic requests plus 550 monthly requests. No transport failure is recorded.

The earlier authoring-environment interruption retained 37/120 points because Pocket APIs were inaccessible there. Your local collection resolved it. Your supplied log does not show a 429 or 403 during this run; it does not establish what happened to other callers.

## Where earnings evidence is missing

| Service | Sampled | Covered | Unknown | Coverage |
|---|---:|---:|---:|---:|
| arb-one | 480 | 218 | 262 | 45.4% |
| base | 600 | 305 | 295 | 50.8% |
| bsc | 360 | 120 | 240 | 33.3% |
| eth | 960 | 317 | 643 | 33.0% |
| opbnb | 360 | 120 | 240 | 33.3% |
| poly | 360 | 219 | 141 | 60.8% |
| robinhood | 240 | 120 | 120 | 50.0% |
| solana | 720 | 233 | 487 | 32.4% |

All unknown outcomes lack indexed claims; none contains an unverified returned payout claim. Nineteen of 34 Application/service groups have no comparable payout in any of their 120 samples. They account for 2,280/2,428 unknowns (93.9%). The other 15 groups account for 148 unknowns. This pattern does not establish inactivity, zero earnings or an indexer defect.

F and sampled earnings use the same covered subset. All sampled sessions remain in coverage denominators. Coverage stays below the 90% ranking guardrail; partial rows can be sorted and inspected but do not receive numeric ranks. Thirty days alone cannot enable an earnings estimate. Selection analysis uses complete rosters independently of payout evidence.

## Separate analysis notebook

`pokt_monthly_analysis.ipynb` includes the exact month and all readable analysis code. Default offline execution checks the compressed checksum, frame, roster eligibility, payout conservation, historical references and coverage partitions. It reconciles amounts/F with 18 outputs from the unchanged website engine and generates service, Application/time and fleet charts.

Optional `MODE="verify"` makes one schema/metadata request plus up to four small indexed-history requests, pinned to cutoff 955836. It asks whether a never-covered Application/service has any indexed history through that cutoff. Returned claims can be outside this month; absence is not verified inactivity. Results/errors are recorded without rewriting the snapshot. This live step has not been executed in the authoring environment; simulated tests cover failures and boundaries.

The CLI module uses only the standard library. The notebook adds Matplotlib for charts; Matplotlib installs NumPy. It exports CSV/JSON/PNG evidence into a separate work folder. The original collection notebook remains the collector.

## Completed monthly follow-up and next extraction

Both diagnostic notebooks have now run successfully on the user's machine. The full-month check returned 37 HTTP 200 responses in 39.52 seconds. It counted claims by numeric session-end height over the exact UTC month, at the original settlement cutoff, and rechecked the original 4,080 sampled session IDs. Every original sampled group count agreed.

Nineteen Application/service groups had no indexed claims anywhere in that month. The remaining 15 groups had 851,096 monthly claim records. More frequent sampling at the same source/window/cutoff cannot recover indexed settlements for the 19 groups. No indexed claim still does not establish no traffic or zero actual income.

The 15 groups with indexed monthly settlements have 1,652 covered out of 1,800 sampled sessions (91.8%), with 148 unknown. This restricted denominator is explained separately; the original sample retains overall 40.5% coverage and all eligibility groups; the separate settlement earnings cohort is explained below. The monthly count is not a download of all payout records. See [the verified findings and per-service totals](monthly-claims-findings.md).

1. Prespecify a claim-first extraction for the fixed eight services, exact session-end month and original cutoff. Check the service-level universe so transient Application groups between registry observations are not silently omitted.
2. Prove the new path on one service over seven days. Paginate bounded requests, checkpoint progress, retain source hashes, and reconcile overlapping claim/distribution records with the existing sampled collector.
3. Obtain historical membership and roster evidence for additional sessions before computing F or domain/owner amounts. Do not assume unchanged ownership or endpoints between sampled registries.
4. Expand to all eight services and the full month once reconciliation succeeds. Preserve raw evidence separately and ship compact derived data within the website's budget.
5. Review how registered selection opportunity and indexed settlement evidence are presented, keeping their different denominators explicit. Do not turn no claim into a verified zero, or drop groups merely to unlock rankings.

The claim-first implementation is now in `collector/settlement_collect.py`, composing the unchanged original HTTP client/parser. The self-contained `pokt_settlement_collection.ipynb` includes all source, frozen reference data, a successful Ethereum seven-day proof and 65 offline failure/reconciliation tests. The real pilot passed 26,888 claims, 1,327 historical rosters and 74 exact overlapping distribution/owner/endpoint checks; the paired investigation, fourteen-day stage and full month have now completed. See [the site audit](site-audit.md) and its proof receipt. Lossless membership packing reduces the measured pilot product by 34.5% without discarding any record. The expanded settlement dataset is installed separately for earnings; the sampled selection evidence is unchanged. The original four-time monthly runner remains unchanged. Repeating the same month, an eight-time sampling grid or the completed diagnostic is not the next action for the main gap found here.

## Hosting and later handoff

The clean monthly source package contains the verified product, original collector/runner/suffix list, tests/build scripts, read-only analysis, audit/reconciliation evidence, branding notices and Vercel configuration. It excludes raw caches, Git history, Site identity and credentials. The one-day file in `tests/fixtures` remains a regression fixture only.

Follow [the detailed Windows setup guide](github-vercel-setup.md) to copy source into the existing GitHub Desktop repository, verify it, publish and import into Vercel. No ChatGPT GitHub plugin is needed. The manual collection Action exports artifacts and does not commit or deploy automatically. Account-specific GitHub/Vercel setup has not been performed by this update.

Hold the Ramiro delivery until the product and evidence are ready. Later include the original collector, runner, pinned suffix list, notebook and explanation together. Nothing has been sent.

## 13 October continuation

The seven-day paired investigation passed: 142 indexed claims matched checked on-chain events without distribution differences. Its bounded negative result does not establish the uncovered-group cause. The fourteen-day stage returned 397,714 claims / 13,415 settled sessions; the month returned 851,096 claims / 29,448 settled sessions. All returned monthly distributions are attributable, all original sampled counts and covered overlaps match, and every fortnight record matches the month. The exact session-end rosters supply historical ownership and service endpoints. The compact month is now installed and saved with the project; no repeat download is required. Original sampled selection and its unknown payouts remain unchanged. See [the integration explanation](settlement-integration.md).

## Sources since 27 October 2026

The indexer no longer serves `eventClaimSettleds` or `modToAcctTransfers`, so every collector now reads the pocketdex session catalog on `data.pocket.network/graphql` (`collector/session_catalog.py`):

| Data | Function |
|---|---|
| Sessions, rosters, member owners, payouts (V and each member's share), settlement heights | `getSessionRostersJson` |
| Members' endpoints | `getSuppliersConfigHistoryJson`: the config declared before the session start (a change takes effect at the next session) |
| Eligible Suppliers and owners at a sample point | `getStakedSuppliersList`, at the height before the covering session's start |
| Session cap, session length and settlement offsets | `getParamHistoryList` |
| Service names and compute units per relay | `services(blockHeight: cutoff)` |
| Monthly claim counts (diagnostic notebook) | `getNetworkSessionsJson`, corrected at both month edges with `getSessionRostersJson` |
| UTC boundaries and block times | `blocks` |

Each service's census pages must hold every settled seat that `getNetworkSessionsJson` totals for the same session starts, or the run stops. The re-collection reproduced the previous month exactly: 29,448 sessions, 851,096 claims, every pool, payout, roster, owner and endpoint set, and the 960 populations, 4,080 sampled sessions and 1,652 covered sessions. Known differences: sampled rosters are listed by address, not in the chain's selection order (only membership is used); `indexedEstimatedRelays` is null, because the catalog has no per-session estimated relays; the service `svc-poktminer` is named "delete" at the cutoff height; and 32 pilot session end times lose sub-millisecond digits. The paired on-chain investigation still uses the archive RPC `block_results`, as an independent check.

