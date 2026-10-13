# Recorded earnings and sampled selection

Updated 13 October 2026. Public GitHub, Vercel and the Ramiro handoff remain deferred.

The site now has the separately reconciled **monthly indexed-settlement earnings cohort**, 6 September–5 October 2026: **851,096 claims and 29,448 settled sessions**, with attributable distributions for every returned session. The original selection sample remains intact: 120 observation points, 4,080 sessions, 1,652 covered payouts and 2,428 unknown outcomes. The old repeated payout warning described that sampled evidence, not a missing calendar month.

A separate collection starts from indexed settlements and retrieves each payment and its historical selected roster. The successful Ethereum proof covers 29 September–5 October: **26,888 claims, 1,327 settled sessions, 224 sampled claim counts checked and 74 exact payment/owner/endpoint overlaps**. The paired investigation additionally matched **142 payments** in actual block events without differences. No matching uncovered-group settlement appeared in the three checked blocks. That does not establish the cause across the entire group or prove zero income.

The full-month ZIP is independently verified and its compact evidence is now saved with the project source. All 4,080 sampled counts, 1,652 covered overlaps and 13,415 prior fortnight sessions reconcile; the fortnight receipt and checksum are separately verified. **No re-upload or repeat collection is needed to publish this month.**

| Product question | Evidence used | Boundary |
|---|---|---|
| How much recorded gross income did this fleet earn? | Returned indexed settled sessions and attributable Supplier distributions | Does not certify every registered session, owner profit or all traffic |
| How did it compare with equal sharing? | The same payments and exact selected members; pool × your positions ÷ all positions | No-claim sessions outside the index are not filled with zeros |
| How often was it selected? | Original sampled historical registries, rosters and eligible populations | A four-time daily sample, not every session |
| What happens if the fleet grows? | Separately dated eligible population and selection cap | A uniform-selection model, not promised traffic or earnings |
| Does an earlier earnings pattern hold up? | Earlier and later recorded payments separated by a two-day gap | A historical conditional test, requiring enough separate evidence |

## What the source now implements

- `src/settlements.js` validates the lossless packed evidence and follows each session's actual owner and service endpoints. It never invents eligible N from claims. It can find endpoints observed between the original sample heights.
- `src/engine.js` uses settlements for earnings, trends, breakdowns and historical tests. Selection and fleet-size scenarios retain the original sample. No-claim Application groups stay inspectable and unavailable.
- `scripts/prepare-settlement-tables.mjs` computes owner/domain comparison tables once. F and gross earnings sort independently. Opportunities and informative days become the useful table evidence column after activation.
- `src/app.js` labels recorded earnings and sampled selection separately, explains their denominators, preserves original coverage inspection and shows specific prediction evidence failures.
- `scripts/import-settlement-month.py` verifies a review ZIP offline. A seven-day proof cannot be installed as a month. It checks canonical and packed hashes, a lossless round trip, exact integer/Fraction conservation, sampled overlaps, known monthly group counts and the reviewed fortnight.
- The build keeps every static file below 24 MiB. When monthly settlements are activated, a saved binary data asset is served alongside the HTML. Its SHA-256 is checked before use. Failed loading stops clearly; it does not silently substitute the old sampled earnings.

For the whole-network scope, actual and equal-share totals coincide by construction. F = 1 describes that accounting identity, not network quality. Identical observed daily ratios have a collapsed empirical range; that range does not guarantee future certainty.

## Install the completed monthly ZIP locally

The following steps explain the optional importer. The current project already contains the installed month, so you can skip collection and import when using this current source. Use the importer if independently rebuilding from your review ZIP. It operates on website source, separate from Jupyter's raw collection cache.

1. Download and extract the latest `pokt_fleet_analysis_monthly_source.zip`. Open the extracted `pokt-fleet-analysis` folder. Verify that `package.json`, `src`, `data`, `collector`, `scripts` and `tests` are visible at this level.
2. Keep the completed monthly `review-results.zip` in your collection work folder. Do not extract it or put raw collection caches in the website repository. The importer reads the ZIP itself.
3. In File Explorer, click the website source folder's address bar, type `cmd`, then press Enter. The new terminal should show this source folder as its current directory.
4. Run `python --version`. Keep the Python installation that successfully ran the notebook. If Windows uses the launcher instead, `py --version` works; use `py` in place of `python` below.
5. Run `node --version`, then `npm --version`. Node.js 22 is the prepared workflow version; the source supports Node.js 20 and newer. Python and Node.js perform different jobs.
6. Validate the ZIP first. Substitute its actual Windows path; keep the quotation marks:

   ```bat
   python scripts/import-settlement-month.py "C:\Users\mwil8\Documents\1 --- pokt\pokt-staged-collection\pokt-staged-work\review-results.zip" --check-only
   ```

7. Read the final result. A full month's `monthlyActivationReady` must be `true`. The fixed reference expects **851,096 claims**, **4,080 sampled claim counts**, **1,652 covered overlaps**, all eight services and all 30 UTC dates. The verified settled-session total is **29,448**, and the reviewed fortnight contains **13,415** matching sessions. If the result says `false` and 26,888 claims, it is the seven-day proof. Stop installation and use the completed monthly ZIP.
8. Install only after that validation succeeds:

   ```bat
   python scripts/import-settlement-month.py "C:\Users\mwil8\Documents\1 --- pokt\pokt-staged-collection\pokt-staged-work\review-results.zip"
   ```

   This writes separate monthly settlement data and receipts. It never overwrites `data/live-snapshot.json.gz`.
9. Run the checks and build, one command at a time:

   ```bat
   npm test
   python -m unittest discover -s tests -p "test_*.py"
   npm run build
   npm run check
   ```

10. After all checks pass, serve the complete built folder:

    ```bat
    python -m http.server 8000 --directory dist
    ```

    Open `http://localhost:8000` in your browser. Keep that terminal open. Verify that the earnings banner explicitly names indexed settled sessions and sampled selection. Compare owner/domain groups; toggle F versus earnings; inspect unknown Application groups; check Summary, Breakdown, Past performance and Diagnostics.

11. Save or share the exact console error and the saved review ZIP if a gate fails. A failure does not justify removing missing groups, relaxing evidence thresholds or treating absent claims as zero.
12. Complete the desktop/mobile checklist in `docs/review-guide.md`. Only then follow the detailed manual GitHub/Vercel setup guide and prepare the final Ramiro notebook and readable Python files.

## Verification completed here

Actual monthly checks cover all 765 service-subset/period views, every precomputed owner/domain row, all 198 owner partitions against independent exact Python arithmetic, all 48 F-sort controller cases, endpoint ownership/service intersections, sparse and missing groups, pagination and complete exports. Actual Kleomedes historical tests are available for all eight services; short periods deliberately remain unavailable. See [the current site audit](site-audit.md).

The suite includes 80 JavaScript tests, 101 Python tests, 62 offline notebook tests and 167 original report checks. Complete monthly downloads use compressed JSON without omitting any evidence. Original selection metrics and collector/runner hashes are unchanged.

Native browser layout, focus trapping, clipboard, downloads and served-asset review remain open. Public GitHub, Vercel and Ramiro handoff remain deferred until that review. The 19 absent-index groups still have an unresolved cause; no payout has been invented for them.
