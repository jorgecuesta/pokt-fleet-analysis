# Start here: review the finished month, then publish

Prepared 13 October 2026. This refined package contains the current monthly product, clearer evidence labels, the Past performance tab, specific sparse-data reasons, and the source and manual setup guide. Collection is finished. **Do not rerun the old analysis or collection notebook to complete this setup.**

## What changed in this refinement

- Predictions is now **Past performance**. Existing saved views still open.
- Earnings evidence is labelled **Verified recorded settlements**; the older drawer is **Original sampled payout evidence**.
- Sparse groups show a specific reason such as **Only 3 days with opportunity**, **Only 12 opportunities**, or **No recorded payouts**.
- Explore retains four initial suggestions; detailed group/source statistics stay in drawers.
- Long badges and the Past performance tab can wrap at narrow widths. Native browser layout still needs your review.
- The monthly files and numerical calculations are unchanged.

## Your next action

1. Download `pokt_fleet_analysis_refined_2026-10-13.zip`.
2. Right-click it in File Explorer and choose **Extract All…**. Extract into your normal Pocket work area, for example `C:\Users\mwil8\Documents\1 --- pokt\`.
3. Open the extracted `pokt-fleet-analysis` folder. The correct folder directly contains `package.json`, `START_HERE.md`, `Open_Local_Review.cmd`, `src`, `data` and `dist`. Do not run files from inside the ZIP viewer.
4. Double-click **Open_Local_Review.cmd**. It uses your existing Python, checks the saved monthly asset, starts a local server and opens your browser. Keep the command window open; Ctrl+C stops it. This does not collect data or publish anything.
5. Follow the six checks below. Node.js is not needed for this already-built local review.

If double-clicking does not work, click the project folder's address bar, type `cmd` and press Enter. In that window run `py -3 scripts\review_locally.py`. If your existing Python command is `python`, use `python scripts\review_locally.py`. The script prints the URL, normally `http://127.0.0.1:8000/`; use the exact printed URL. It tries another nearby port if 8000 is already occupied.

You may instead review [the private published Site](https://pokt-fleet-analysis-phase-one.brawny-birch-3847.chatgpt.site/). The local copy lets you also verify exactly what will go to Vercel.

## Six browser checks

| Check | Do this | Expected result |
|---|---|---|
| Find a fleet | Search Nodefleet and Kleomedes; try a partial hostname and an address | Recorded owner/domain groups and relevant services appear; no invented business ownership |
| Sort comparisons | Compare fleets → Ethereum → 30 days; toggle Recorded earnings / F score in both owner and domain modes | The row order changes; sparse groups can remain unranked |
| Read Summary | Open Kleomedes, Ethereum, 30 days; inspect F, earnings, selection and their explanations | Recorded earnings use the reconciled settlement cohort; selection uses the original sample |
| Test periods and services | Open Past performance for that fleet; then try 7/14 days, multiple services and an exclusion | The monthly historical test works; short windows explain why they cannot form a separate month-long test |
| Inspect and navigate | Try Breakdown/Diagnostics, a group filter and session/endpoint drawers; narrow the window, use Tab and Escape | Long addresses/tables/charts remain usable; dialogs contain keyboard focus and return it when closed |
| Share and download | Copy a view link, use Back, and download a fleet result | Correct scope returns; the complete monthly download is `.json.gz` and decompresses to JSON with both evidence sets |

Use [the full browser checklist](docs/review-guide.md) for the detailed cases, including 390 px, 768 px and desktop widths.

**Expected evidence:** 6 September–5 October UTC, eight services, 851,096 indexed claims and 29,448 settled sessions. Every returned distribution is attributable. The older sampled payout drawer still shows 1,652 / 4,080 = 40.5%; that is intentional. Its missing sessions remain unknown. A sparse Supplier can still lack enough observations for a rank or historical test.

The fact that 5 October is the last date does not mean there is only one day: it is the end of the saved 30-day window. There is no automatic refresh.

## What the components mean

| Component | Purpose | Needed now? |
|---|---|---|
| Python | Runs the local review server and collection/analysis code | Keep the installation that successfully ran your notebooks |
| Node.js 22 and npm | Build the website and run JavaScript checks | Needed when checking/building source before GitHub; not for the prebuilt review |
| GitHub Desktop | Saves local commits and uploads source to your GitHub repository | After browser review |
| GitHub repository | Your public source archive and automated checks | After browser review |
| Vercel | Builds that repository and serves the website publicly | After GitHub checks pass |
| Jupyter | Inspects collection code and results cell by cell | No new notebook run is required for setup |
| `data` | Both saved evidence sets and their receipts | Included; keep them |
| `dist` | The already-built HTML and its hashed monthly binary asset | Serve the whole folder |
| Raw collection cache | Resume/audit evidence on your laptop | Keep it outside the public website repository |

## After the browser review passes

Follow the expanded **62-step guide**, [docs/github-vercel-setup.md](docs/github-vercel-setup.md), one stage at a time. Every stage has a checkpoint and common-error remedies. It explains the exact folders, terminal commands, GitHub Desktop clicks, Vercel settings and expected output. If you already created a repository, reuse it.

The sequence is **local review → check/build source → commit locally → publish your public GitHub repository → wait for its checks → import into Vercel → review the production URL → prepare Ramiro's handoff**.

GitHub and Vercel have not been set up in your accounts by this update. Nothing has been sent to Ramiro.

## If something fails

Keep the command window open and copy its complete error. Report the page/tab, selected scope, services and period, what you clicked, and expected versus actual behaviour. For a screenshot, include the date/service controls and the error.

The `docs/browser-review-record.md` file is a short record you can fill in. A checklist supplied here is not a claim that native browser QA has already passed.
