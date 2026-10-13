# Product data contract v1

The UI consumes discovery, scope, selected-service and analysis models through an adapter. `createIllustrativeAdapter()` supplies fictional evidence and `createLiveAdapter()` supplies the validated historical mainnet snapshot. Both preserve the same semantics and availability rules. A live snapshot additionally requires a fixed indexer cutoff and recorded source metadata.

See `src/product-contract.d.ts`, `docs/product-report.schema.json` and the actual generated `docs/example-report.json`. The JSON schema validates report shape; the invariants below additionally constrain meaning.

## Adapter operations

| Operation | Returned model / meaning |
| --- | --- |
| `snapshotInfo` | Version, data mode, generation time and saved observation period |
| `directory()` | Explicit named fleets, descriptions, identity counts, services and example cases |
| `search(input)` | Typed matches: fleet, Supplier, owner, hostname or domain; matching explanation, identities, parent fleet names and initial service |
| `servicesFor(scope, filters)` | Registered services, latest eligible counts and eligibility availability; retain registered services with no eligibility |
| `suppliersFor(query)` | Recorded identities respecting active Supplier filters and historical membership; owner history, endpoints, registration and observed eligibility |
| `getReport(query)` | One period model: scope, rewards, exposure, per-service scenario references, time pattern and evidence |
| `getGroups(query, dimension)` | Stable group keys and readable labels for a partition |
| `getBreakdown(query, dimension, options?)` | Per-group rewards, uncertainty, coverage and child query; an explicit overlap flag and total group count. An optional identity-row limit reduces displayed-page work; full export retains every group. |
| `getSelectionDiagnostic(query)` | Selected-count histogram and model expectation using historical populations, with descriptive simulation guides |
| `getSessionPoints(query)` / `getSession(query, id)` | Comparable payout opportunities and an inspectable session record |
| `getPersistenceDiagnostic(query)` | An EarningsEstimate model: availability, explicit fit/gap/test dates, dated daily actual/equal-share/estimated amounts, covered-session counts and POKT errors |
| `exportResult(query, dimension)` | The complete report, breakdown, EarningsEstimate and included session evidence with disclosure |

Each adapter rejects the other data mode. Dates and reference labels come from report metadata. The live directory uses historical owner-address cohorts and endpoint associations, without business-name attribution. `serviceCatalog()` lists every registered service ID; `leaderboard(serviceId, period)` returns precomputed within-service comparisons. Only detailed collected services can open analysis. Sparse and partial rows stay visible without a rank. Period choices collapse to the actual collected window when less history is available.

## Query and membership

`query = {scope, serviceIds, period, filters}`. `serviceIds` is a nonempty list of registered service IDs. Legacy single-service inputs using `serviceId` remain accepted; reports return a sorted, deduplicated `serviceIds` list. If both fields are supplied, `serviceIds` determines the measured sessions. Scope is `{type, value, fleetId?}`; the optional `fleetId` restricts an endpoint match to an explicit fleet. Periods currently represent the last 7, 14 or 30 days of the saved snapshot, with an inclusive start and exclusive end in UTC. There is no implication that the dates are current.

Filters form an intersection. Supplier filters change the measured identities; service, Gateway, application, time, selected-count and pool-value filters change the included sessions. Grouping replaces the filter for that same dimension and retains the others, so siblings can still be investigated. Filter chips make this behavior visible. Saved view links accept one filter per dimension and reject duplicate dimensions.

| Scope | Required rule |
| --- | --- |
| Fleet | An explicit directory association, with service-specific historical eligibility |
| Network sample | The explicitly measured directory identities across selected services; disclose sample boundaries, coverage and unobserved population |
| Supplier | One fixed identity; ownership transfer does not rewrite its earlier observations |
| Owner | Membership at each observation time, rather than the latest list projected backwards |
| Hostname / domain | Recorded endpoint associations, strict domain boundaries, de-duplication by Supplier ID and no inferred business union |
| Infrastructure group | An explicit association with evidence; a hostname by itself is insufficient to identify a backend |

The Phase 1 endpoint/group directory is fixed over the example period. A real source must supply effective intervals when endpoint or infrastructure associations change. Fleet associations and Gateway/application relationships require provenance and an explicit unknown state.

## Required raw evidence

This fictional engine demonstrates one input representation; a real collector can use another representation and adapt it.

| Entity | Minimum evidence |
| --- | --- |
| Snapshot | `schemaVersion`, immutable `snapshotId`, data mode, generation timestamp, period, sampling description and source notice |
| Supplier | Stable ID, explicit fleet/group associations, endpoint hosts, dated owner history and registered service IDs |
| Service population | Unique ID, service, observation time, total eligible population N, eligible measured identity IDs and selection cap |
| Session | Unique ID, UTC start, service and population reference; actual selected count K, roster availability and selected measured identities |
| Settled payout | Payout availability, total **gross Supplier payout pool** V, amounts attributed to selected measured identities and outcome availability time |
| Traffic mapping | Application ID, supported Gateway association or explicit null/unknown; do not hide unmapped sessions |

The population total includes all eligible Suppliers. The measured roster and payout arrays may contain only the directory identities, provided the total selected count and gross payout pool include the entire session. The total pool must not be mistaken for the measured subset’s payout.

Each population must be associated with the right historical sessions, and latest references must be explicitly ordered by observation time. Owner intervals use inclusive starts and exclusive ends. Endpoints must be normalised safely; domain matching is equality or a `.`-delimited suffix.

## Headline calculations and units

For session j:

- `Nⱼ`: all eligible Suppliers; `nⱼ`: this scope’s eligible Suppliers.
- `Kⱼ`: all selected identities; `Xⱼ`: this scope’s selected identities.
- `Vⱼ`: settled gross payout pool in **POKT**.
- `Bⱼ = Vⱼ × Xⱼ / Kⱼ`: equal-share amount in POKT.
- `Yⱼ`: actual gross POKT attributed to this scope, across revenue-share recipients.

Earnings comparison requires a verified roster, completed payout outcome and positive K. Both totals include exactly the same sessions. `F = ratio = ΣY / ΣB`, not a mean of session ratios. F = 1 means equal share; F = 1.2 corresponds to +20%; F = 0.8 corresponds to −20%. `differencePercent = (ratio − 1) × 100`; its intervals use **percentage points of difference**. Actual and equal-share amounts are gross earnings, not owner net profit.

Observed presence is `verified sessions with X > 0 / all verified sessions`. Mean selected is `ΣX / all verified sessions`, including zero selections. Unknown rosters are excluded from those denominators. Historical model expectations use each verified session’s N, n and K, rather than the latest reference for the entire period.

## Multiple services and network boundaries

The report exposes `services`, `perService` reward/exposure models and `scenarioReferences` with service IDs. For multiple services, `service` is a compatibility display label (`selected-services`); it is never a population to feed into the selection model.

Combined F uses total actual POKT divided by total equal-share POKT across the selected service sessions. Do not average F scores, percentages or uncertainty endpoints. Observed presence and mean selected use verified session counts, not a mean of service percentages. Every service session is included once. Service-specific N, n, K and payout pools remain attached to that service session.

Fleet identity counts are unions of Supplier IDs, not sums of per-service eligibility. The latest reference count similarly unions measured eligible identities across selected service references. Each UTC day contains all selected-service observations for day resampling; selecting three services does not turn 30 days into 90 independent days. Semantically identical service sets and filters receive identical resampling seeds.

Coverage and availability are recomputed both in aggregate and by service. A well-covered aggregate can conceal a smaller incomplete service, so the UI flags service gaps and exposes per-service covered-session counts. Registered but ineligible services remain selectable. Removing a service removes its sessions from the view and all compared totals.

The network view measures eight fictional fleets and 305 directory identities. The larger anonymous eligible population is used only for selection references; it supplies neither observed earnings nor a whole-network census. Fleet comparisons remain descriptive and retain the same service/evidence context.

## Availability and uncertainty

`rewards.availability` is `available`, `limited`, `partial` or `unavailable`, always accompanied by the quantities and a reason when constrained. Coverage is comparable outcomes divided by recorded sessions in this query. Informative days have positive B; positive opportunities are sessions with positive B. Their counts must not be substituted for recorded or verified counts.

Verified zero payouts remain zero. Missing and pending payouts have null values, never zero. A missing roster makes X and the earnings comparison unknown even if payout records exist. No positive B makes the ratio unavailable rather than treating the fleet as underperforming.

The fictional product estimates a 95% range by resampling whole observed UTC days with replacement 2,000 times. Each day carries actual and equal-share amounts together across every selected service; every draw recalculates the ratio of totals. The adapter returns the draw count, interval and evidence flags. A range does not repair missing observations, sample bias or between-day dependence.

The UI classifies earnings only with at least seven informative days, 24 positive opportunities, 90% comparable coverage, no day above 40% of opportunity, and a usable uncertainty range. These thresholds are exploratory display rules. A constrained arithmetic ratio can remain inspectable without receiving a supported headline classification.

Each group recomputes its own evidence and interval. Overlapping hostname groups cannot be added as a partition. Intervals are descriptive; overlapping or non-overlapping ranges are not a formal pairwise test. Multiple exploration can uncover chance patterns.

## Scenario contract

`scenarioReferences` supplies one `{serviceId, serviceName, observedAt, totalEligible, ownEligible, selectionCap, populationId, assumption}` for each selected service. The legacy `scenarioReference` is populated only for a single service and is null for multiple services. Each is a **separately dated reference**, not a headline-period average or future forecast. Identity filters affect its own count; session filters do not redefine the network population.

The scenario service selector chooses exactly one of these references. It cannot create a blended network population or probability. Changing this selector does not change historical earnings.

Let `other = totalEligible − ownEligible`. A proposed count n gives `N = other + n` and `K = min(selectionCap, N)`. Uniform sampling without replacement gives `X ~ Hypergeometric(N,n,K)`, `P(X≥1) = 1 − C(N−n,K)/C(N,K)`, and `E[X] = K × n/N`. Minimum-position targets sum the appropriate distribution tail. Presets or custom positive integer X thresholds are supported. A finite target greater than 0 and no higher than 1 returns the smallest integer count that meets it, or null if the cap/100,000-count limit makes it impossible. For a target of 1, a count is returned only when the support guarantees X selections; floating-point rounding cannot turn a near-one chance into certainty. Custom Y% input and the curve retain decimal target labels.

Every proposed identity is assumed eligible. Other Suppliers and the cap remain fixed. The tool changes both own fleet size and total network size. It leaves every historical reward amount, ratio and uncertainty range unchanged. Presence and expected positions are distinct, especially when presence has already saturated.

## Time diagnostics and reproducibility

The month’s earlier/later warning is descriptive and separate from the dedicated Past performance evaluation. Persistence fits the first thirteen days of the saved month, excludes a two-day gap, and evaluates the remaining fifteen days. Only training payouts available before the test may enter the fit. Missing or late training outcomes remain in the training coverage denominator. Later opportunity is observed; this is a conditional explanation test rather than an advance revenue forecast. Error is mean absolute POKT error per compared UTC day. EarningsEstimate provides trainingPeriod, gapPeriod and testPeriod with inclusive start/exclusive end, training evidence, test coverage, earlier/later F and a dated daily series. Each daily entry carries actualPokt, equalSharePokt, earlierEstimatePokt and comparableSessions. The estimate sums min(session pool, earlier F × session equal-share amount); all three series use identical covered sessions. Export includes this model, including its unavailable state.

Snapshot IDs, selected services, scope, period, active filters, grouping, chart measure, scenario service, proposed count, custom minimum, decimal target, diagnostic selection and the active Summary/Breakdown/Past performance/Diagnostics view are retained in the view link. An unavailable snapshot is rejected clearly rather than silently substituting a different one. Exports include all query frames and their service IDs, not just points sampled for a chart. Weekly chart labels are clipped to the included period. Category amount charts use paired dots on a common POKT scale; difference mode uses dots on a shared symmetric scale centred at equal share (0%). Every row labels actual/equal-share amounts, relative difference, F and evidence. A weekly POKT line chart appears in every Summary, with the same covered-session rules. The session scatter uses a sample that includes extreme outcomes, with axes based on all included opportunities. Exact records and evidence remain available. The generator and resampling seeds make fictional results reproducible.

Replacing fictional evidence requires this contract and its invariants to hold; it does not mean the existing V5 export has already been audited or satisfies the interface. That work belongs to Phase 2 after approval.

## Terminology and live account mapping

See `docs/terminology.md` for the official actor distinctions and the product partition map. Fleet, infrastructure group and F score are product definitions. Supplier IDs in Phase 1 are fictional stand-ins; they do not separately model real operator accounts or revenue-share recipients. A future adapter must retain Supplier/operator identity, historical owner addresses, revenue-share attribution and relationship provenance without treating a hostname as proof of a common operator.
