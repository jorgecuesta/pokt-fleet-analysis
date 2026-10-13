# Recorded endpoint and identity model

A fleet is an explicit analytical group of Supplier identities. This product supports historical owner-address groups, endpoint hostname/domain groups and their owner subsets. A domain cohort may span many wallets or operators. Supplier identity counts do not count physical machines.

## Who is who

| Record | Meaning | Source |
| --- | --- | --- |
| Supplier / operator address | On-chain service-serving identity | Supplier registry `operator_address` |
| Owner address | Account controlling that Supplier's stake at the observation | Supplier registry `owner_address`, dated membership |
| Service ID | Registered offering that this endpoint serves | Service configuration `service_id` |
| Endpoint | Configured URL and RPC transport for that service | `services[].endpoints[]` |
| Hostname | Normalized host part of the endpoint | URL parser, lowercase/IDNA, trailing dot removed |
| Registrable domain | Registrant or private hosting boundary | Pinned Public Suffix List, including its private section |
| Provider name | Search fragment such as Nodefleet or Kleomedes | Match against observed domain/hostname text; not verified business attribution |

## URL components

The live catalogue contains `base.pocket.kleomedes.network`. Its hostname labels are `base`, `pocket`, `kleomedes`, `network`; its public suffix is `network`; its registrable domain is `kleomedes.network`; its subdomain labels are `base`, `pocket`. The service is taken from the registered configuration, not guessed from `base` in the hostname.

Each catalogue entry contains an endpoint ID, source URL SHA-256, service ID, RPC type, parse status, scheme, hostname, explicit and effective ports, path and path segments, query keys, registrable domain, public suffix, subdomain labels and hyphen-separated token groups. The original labels remain intact alongside their tokens. Tokens such as `eu`, `mainnet` or numeric segments are not converted into verified region, environment, server or operator attributes.

Invalid URLs remain explicit records with a source hash and parsing reason. IP addresses and single-label hosts remain distinct from registrable domains. Ports, paths and transport variants are retained separately; repeated endpoint records are interned by service, original URL hash and RPC type.

Public safe URLs omit userinfo, query values and fragments. The raw, hashed source response preserves the original URL. The path is retained as configured, without decoding or rewriting its semantics.

## Account address components

Pocket accounts are checked for the Bech32 `pokt` prefix, alphabet, checksum, padding and 20-byte account payload. Metadata retains the encoding, prefix, byte count and payload hex. These are encoding components, not provider, geographic or physical-server information. The actor's role comes from its registry field. Revenue-share recipients are separate relationships; gross indexed Supplier distributions sum all relevant recipients and do not represent owner profit.

## Time and service membership

Supplier `endpointHistory` stores endpoint catalogue IDs, observation interval and first/last observed archive heights. `ownerHistory` stores dated owner relationships. Every session uses its own service's historical eligible population and the endpoint association at that observation. A Supplier with a Base endpoint under one domain and an Ethereum endpoint under another only belongs to the corresponding domain cohort for each service. The same Supplier is counted once in a combined view.

For an owner subset of a shared domain, both owner membership and endpoint association must match at the observation. A later owner transfer does not rewrite earlier observations. History boundaries reflect observations; changes between the four daily samples are not continuously measured.

Hostname and domain breakdowns can overlap when a Supplier has multiple endpoints. Their totals must not be added. Domain service comparisons use the same eligibility, payout and equal-share calculations as opening that group in analysis. Owner comparisons remain separately selectable. Sparse or partial rows remain unranked.

## Provenance and reproducibility

The PSL copy is unmodified version `2026-10-07_07-28-19_UTC`, upstream commit `3929462652695bad04f0a27afb600974014a3c8b`, SHA-256 `ba7d836c0ea57a8bcf9f1fcb868066a7554bed029b441ecc6204ad8494a32612`. Its MPL 2.0 notice is retained. Updates require changing the reviewed hash pin.

The preserved one-day regression fixture was enriched from its original archive-height cached registries. The current product is now the completed 6 September–5 October monthly collection: 120 shared points, 4,080 unique sampled sessions, 1,652 comparable payout outcomes and 6,698 service-specific endpoint records. The original parsing rules and pinned suffix list are unchanged. One invalid endpoint remains explicit. In this month 2,851 Supplier identities have observed endpoint-history changes; none has a recorded owner change. Absence of an observed change does not establish what happened between samples.

Source references: [Public Suffix List](https://publicsuffix.org/list/), [Pocket Supplier staking](https://docs.pocket.network/node-operators/supplier-staking/), [Pocket protocol architecture](https://docs.pocket.network/protocol/architecture/).
