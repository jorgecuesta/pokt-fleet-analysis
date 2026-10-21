# Fleet Observatory

An independent research prototype, not an official network product.

Analyse historical Pocket Supplier fleets by owner address, Supplier, hostname or recorded endpoint domain. Earnings and selection have separate evidence sets, visibly explained throughout the product.

The default saved mainnet window is **6 September–5 October 2026 UTC**, covering **arb-one, base, bsc, eth, opbnb, poly, robinhood and solana**. There is no automatic refresh. `?dataset=preview` opens the separately labelled fictional product.

## Monthly evidence installed · 13 October 2026

- **Recorded earnings:** 851,096 indexed claims across 29,448 settled sessions. Every returned session has attributable Supplier distributions and an exact historical session-end selected roster.
- **Original sampled selection:** 120 observation points, 960 service observations and 4,080 unique sessions. Its payout evidence stays 1,652 covered / 2,428 unknown; it is not overwritten or zero-filled.
- All 4,080 sampled claim counts and 1,652 covered payout/owner/endpoint overlaps reconcile. All 13,415 reviewed fortnight sessions agree exactly with the month; its receipt and checksum are verified separately.
- 4,500 Supplier identities, 198 owner-address groups and 6,699 service-specific endpoints are mapped. Business ownership, geography and physical machines are not inferred.

The seven-day Ethereum proof and paired on-chain investigation are retained. The paired control matched 142 indexed claims to actual block events without payment differences. Its bounded negative probe does not establish the cause of whole-group index absence or certify no actual income.

## Start here

Open [START_HERE.md](START_HERE.md) for the current package, the Python local-review launcher, and the order of setup. No collection or old notebook rerun is needed.

- [How the two evidence sets work](docs/settlement-integration.md)
- [Whole-site audit and remaining release checks](docs/site-audit.md)
- [Detailed Windows, GitHub Desktop and Vercel setup](docs/github-vercel-setup.md)
- [Collection evidence](docs/data-collection.md), [terminology](docs/terminology.md) and [endpoint parsing](docs/endpoint-model.md)
- [Browser review checklist](docs/review-guide.md)

Source: https://github.com/mykyal/pokt-fleet-analysis. Website: https://pokt-fleet-analysis.vercel.app/.
The neutral branding in this source update appears on the website after it is committed, pushed and successfully deployed.

## Build and verify

The package pins Node.js 22.x to match the prepared workflow. Python 3.13 is used in that workflow; authoring checks here ran on Node.js 24.19.0 and Python 3.12.14. Keep the Python installation that successfully ran the notebooks; Python 3.12 also works. Node.js runs the website build; Python runs collection and analysis. No external npm dependencies or product API keys are required.

```sh
npm test
python -m unittest discover -s tests -p 'test_*.py' -v
python scripts/verify-settlement-notebook.py notebooks/pokt_settlement_collection.ipynb
npm run build
npm run check
python -m http.server 8000 --directory dist
```

Open `http://localhost:8000`. Serve the entire `dist` folder: the HTML loads the saved, content-addressed settlement binary from the same deployment and verifies its SHA-256 before use. Opening a downloaded HTML file alone cannot load that asset. Recent browsers with gzip stream support are required. Failed loading stops clearly rather than silently substituting sampled earnings. Every static asset is kept below 24 MiB.

Checks include 80 JavaScript tests, 101 Python tests, 62 notebook offline tests and 167 original report-schema checks. Actual monthly integration covers all 765 service-subset/period combinations, all 198 owner partitions against independent Python integer/Fraction results, every precomputed owner/domain row, all 48 service/period/grouping F-sort combinations, historical membership, nested filters, predictions, pagination and complete exports. Controller tests use a DOM stub; actual browser layout and native interactions still need the checklist.

## Interpret results

F is summed gross Supplier distributions divided by summed equal-share amounts from the same indexed settled sessions. Equal share for a session is its payout pool × your selected positions ÷ all selected positions. `(F − 1) × 100` is the percentage difference. Do not average session or service F scores.

These are recorded gross payments, not net owner profit or proof of all income. Sessions absent from the index are outside this earnings cohort and remain unknown in the original sample. The 19 absent-index Application/service groups are still inspectable. Whole-network F = 1 is an accounting identity, not a service-quality score.

Selection and fleet-size scenarios retain sampled historical eligible populations; settlements do not provide eligible N. Domains and hostnames can overlap, so their totals must not be added. Payments follow ownership and service-specific endpoints in each exact session-end roster.

Sorting follows the chosen earnings or F metric. Numeric ranks additionally need at least seven informative days, 24 positive opportunities, 90% comparable indexed outcomes, no day above 40% of opportunity and a usable descriptive range. Small groups can remain unranked even with complete indexed attribution.

Past performance test an earlier F against later **observed** opportunity, separated by a two-day gap. They are historical conditional tests, not forecasts of future traffic or revenue. Actual monthly Kleomedes views pass in all eight services. Seven- and fourteen-day views deliberately cannot supply a separate month-long test.

Large breakdowns calculate a visible page first. Financial group rows calculate selection when opened in Summary, from its separate sample. Complete monthly downloads are compressed JSON (`.json.gz`), preserving every group, exact monetary string, roster catalog and both evidence sets. Broad network exports can take longer to prepare.

## Collection notebooks

`notebooks/pokt_settlement_collection.ipynb` contains all readable settlement modules, the frozen original reference, a successful seven-day proof and 62 offline tests. It starts with `MODE = "offline"`; live modes are `investigate`, `7d`, `14d` and `30d`. `REUSE_INCLUDED_PILOT = True` reuses the matching included proof. Keep its `pokt-settlement-work` folder beside the notebook to preserve resume caches. **The completed month is already installed; do not recollect it merely to publish.**

The original collection, monthly analysis and claim-diagnostic notebooks are retained. The original collector, runner and pinned Public Suffix List are unchanged. The immutable sampled product SHA-256 is `059ffa4dba60e0c4e3f0f3810cdf778c87d09560c65a701735de5777b84b3b57`; the installed packed settlement SHA-256 is `d24c43b4f040cdbffad57bb4698f43164063876721a581d15ec2f7e3a56c3fe0`.

`python scripts/import-settlement-month.py /path/to/review-results.zip --check-only` independently verifies the completed ZIP without API requests or data mutation. Without `--check-only`, only a reconciled full month can be installed as separate settlement evidence. The original sample is never overwritten.
