# Browser review of the monthly fleet analyser

Updated 13 October 2026. The actual month is installed: 6 September–5 October UTC, eight services, 851,096 indexed claims and 29,448 settled sessions. All returned distributions reconcile. Original sampled selection stays separate: 4,080 sessions, 1,652 covered payouts and 2,428 unknown outcomes. There is no automatic refresh.

## What each view answers

| View | Question | Evidence |
|---|---|---|
| Find a fleet | Which recorded group should I inspect? | Names/domains/hostnames/addresses, four initial suggestions, owner/domain grouping |
| Compare fleets | How do groups compare in this service and period? | Recorded gross earnings or F sorting; informative days and opportunities; sparse groups stay unranked |
| Summary | Did recorded earnings exceed equal share? How often was I selected? | Earnings use exact settlement rosters; selection uses sampled eligible populations |
| Breakdown | Where did the earnings difference appear? | Dot comparisons and time lines, exact amounts, intersecting filters; overlapping domains must not be summed |
| Past performance | Did an earlier earnings estimate hold up later? | Earlier F applied to later observed opportunity with a two-day gap; a historical test, not a traffic forecast |
| Diagnostics | What happened within the sessions? | Separate sampled selection and indexed session payments; inspectable source times, heights and endpoints |

F is actual gross distributions / equal-share opportunity from the same sessions. The percentage is `(F − 1) × 100`. Service totals combine before F. Selection scenarios use a separately dated eligible population and do not change historical earnings.

## Complete these browser checks before public setup

1. Review 390 px, 768 px and desktop widths. Check four suggestion cards, long domains/addresses, tabs, contained table scrolling and readable charts.
2. Search Nodefleet, Kleomedes, a partial hostname, a complete endpoint URL and a Supplier/owner address. Inspect its recorded service associations and historical endpoint components.
3. Switch discovery/comparison tabs with pointer and keyboard. Change owner/domain grouping, service and 7/14/30-day period. Toggle recorded earnings/F; confirm ordering changes. Expand rows and inspect evidence, then open the group.
4. Review Summary for a large domain and a small Supplier. Open F, evidence and scope drawers. Confirm the two evidence sets are explained. Inspect daily earnings and the separate selection-presence visual.
5. Change scenario fleet size, custom X and custom Y% target. Check zero count, impossible targets and reset. Historical earnings should stay unchanged.
6. Select multiple services, exclude one, and return to a single service. Inspect combined amounts and the service-specific population used by the scenario model.
7. Try owner, Supplier, hostname/domain, Application, week/hour and payout-value breakdowns. Apply intersecting filters, remove them and paginate. Domain totals must carry the overlap explanation; no-index Applications must remain unavailable.
8. Open Kleomedes for each service in the full month. Its historical test should be available. Seven/fourteen-day windows and sparse actors should instead explain the specific evidence limitation. The test uses later observed opportunity, not future traffic.
9. Inspect session and endpoint drawers. Dates and heights describe recorded session-end membership. Eligible N must not be inferred from the settlement cohort.
10. Check Escape, native modal focus trapping and return focus, keyboard chart inspection, browser Back, saved URLs and clipboard sharing.
11. Download a fleet result and a broad network result. Monthly files end in `.json.gz`; gzip decompress them with your usual archive tool or Python. Check the scope, all requested group rows, exact payment strings, recorded settlement evidence and separate selection evidence. Broad exports may take longer; no duplicate download should start during preparation.
12. Confirm the default loads its same-deployment settlement asset. Open `?dataset=preview`: it must remain explicitly fictional and use no live monthly asset. Test Alder, Tidal, Copper and Cairn as illustrative scenarios.

## Verified automatically and remaining limits

The suites cover 80 JavaScript tests, 101 Python tests, 62 offline notebook tests and 167 original report checks. Actual monthly checks cover 765 service-subset/period views, 198 owner groups against independent Python arithmetic, every owner/domain table row, all 48 comparison-sort combinations, nested filters, predictions, pagination, exports and gzip round trips.

Controller tests use a DOM stub. Native browser rendering, focus, clipboard, file downloads and served-asset behaviour still need the checklist above. The required browser-control skill is unavailable in this environment; the [Sites rule](skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/sites/SKILL.md) says to skip browser QA rather than improvise another browser-control path.

Rank criteria are display safeguards: seven informative days, 24 positive opportunities, 90% comparable outcomes, no day above 40% of opportunity and a usable descriptive range. Complete indexed attribution does not guarantee sufficient observations for a sparse actor.

Original sample gaps remain visible in Source & evidence. Nineteen of 34 Application/service groups are absent from the index; they account for 2,280 of 2,428 unknown sampled sessions. Their cause is unresolved and no income is invented for them.

After review, follow [the detailed manual GitHub Desktop/Vercel guide](github-vercel-setup.md). Ramiro's handoff stays on hold until the source, evidence and explanations are final.
