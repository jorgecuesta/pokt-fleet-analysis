# Monthly claim evidence · 10 October 2026

**27 October 2026:** the check was re-sourced onto the pocketdex session catalog, because the indexer no longer serves the claim records it queried. The re-run made 39 requests (all HTTP 200) and found the same 34 group counts, 851,096 monthly claims and 47,880 sampled claims. The product SHA-256 is now `feeebfbb120044a782dd60f1879c0613924cb259b7eb528d5f74659055842088`. The record below is the original 10 October run.

The 30-day sampling frame is complete. The uploaded monthly diagnostic confirms that the main earnings gap is a lack of indexed monthly settlements for registered Application/service groups at the saved cutoff. It does not show a failed monthly download.

The exact month is 6 September to 6 October 2026 exclusive, UTC. The original product SHA-256 remains `059ffa4dba60e0c4e3f0f3810cdf778c87d09560c65a701735de5777b84b3b57`, with settlement cutoff 955,836. All 37 diagnostic requests returned HTTP 200 and completed in 39.52 seconds on the user's machine. The reported indexer head was 958,897.

The query resolved the first blocks at or after the two UTC boundaries: 909,560 and 952,159. Its monthly count includes claims with session end height in `[909560, 952159)` and settlement block at or before 955,836. These are session-end membership rules; the product's original observations are labelled by sampled time. Every sampled session end lies within this range.

| Result | Meaning |
|---|---|
| 19 of 34 checked groups have zero indexed monthly claims | More frequent sampling cannot recover indexed payouts for those groups from the same source, window and cutoff. This does not establish no traffic or zero actual earnings. |
| 15 groups have indexed monthly settlements | These groups have 851,096 claim records over the whole month. This is a count, not a download of those records or their earnings. |
| All original sampled counts agree | The 47,880 sampled claim records reconcile by Application/service group with the current indexer. This is not an independent re-audit of every payout amount. |
| 1,652 / 4,080 sampled sessions have comparable payouts | Overall comparable payout coverage stays 40.5%, retaining every eligible group. |
| 1,652 / 1,800 within the 15 groups with monthly claims | This explicitly restricted view has 91.8% comparable payouts and 148 unknown samples. It does not replace overall coverage or unlock existing rankings. |

An Application/service group is a consumer account using a service. Domain and owner-address fleets partition Suppliers; the 19 groups are not 19 Supplier fleets.

| Service | Checked groups | Groups with indexed monthly claims | Monthly claim records |
|---|---:|---:|---:|
| arb-one | 4 | 2 | 102,999 |
| base | 5 | 3 | 116,767 |
| bsc | 3 | 1 | 99,291 |
| eth | 8 | 3 | 120,587 |
| opbnb | 3 | 1 | 100,959 |
| poly | 3 | 2 | 114,189 |
| robinhood | 2 | 1 | 100,632 |
| solana | 6 | 2 | 95,672 |

These totals cover the 34 groups present in the sampled historical registries. They are not asserted to include every Application/service pair that might have existed between observations, all network services, all relays, or every settlement after the cutoff.

The compact, verified result is in `data/monthly-claims-diagnostic.json`. Its provenance includes the raw uploaded diagnostic's SHA-256. It is bound to the exact original product, period and cutoff; the build rejects mismatches. The original compressed monthly snapshot and collector remain unchanged. Website visits make no API requests.

The Source & evidence drawer now explains this result and exposes monthly claim counts alongside sampled evidence. No Application is silently discarded, no unknown payout becomes zero, and the earnings, F and ranking rules remain unchanged.

## Next data work

The useful expansion is more indexed settlement evidence, with an explicitly defined scope. Repeating the same registered groups at more observation times will not create settlements for the 19 groups with no indexed monthly claims at this cutoff.

Prepare a resumable claim-first extraction for the fixed eight services and monthly session-end range. Validate the service-level universe before assuming the existing 34 groups are exhaustive. Retain the same cutoff and preserve unknowns. Collect enough claim and verified Supplier distribution evidence to support gross amounts, and obtain historical roster/membership evidence for added sessions before calculating F or domain/owner totals. Do not carry observations across unseen ownership or endpoint changes.

Prove the new path on one service over seven days, comparing overlapping sampled records against the existing collector. Then expand it to the fixed eight services and full month if reconciliation succeeds. Keep raw evidence outside the public repository and publish compact derived data. Measure request volume, time and compressed output size; do not embed a raw 851,096-record dump in the website.

After validating that extraction and the product's earnings scope, complete desktop/mobile UI review, refresh the source package, create the public GitHub repository manually and deploy it to Vercel. Ramiro's collector and explanation package follows the settled product and data choices.
