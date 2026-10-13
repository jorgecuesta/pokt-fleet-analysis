# Who is who in a Pocket fleet?

This is a fleet analysis tool: it measures an explicitly defined group of Supplier identities, then lets you inspect ownership, infrastructure, services, traffic and time. A fleet is an analysis grouping, rather than an additional protocol actor.

| Term | Meaning and relationship |
| --- | --- |
| Fleet | The explicit set of Supplier identities being analysed; it may span owners, hosts and services. |
| Operator / node runner | The person or organisation running infrastructure. One operator may manage many accounts and Suppliers. An address alone does not identify a business. |
| Operator address | The on-chain account operating a Supplier. It can differ from the owner account and identifies the Supplier for protocol operations. |
| Supplier | A registered service-serving identity with stake and service endpoints. A Supplier identity does not imply a separate physical server. |
| Owner address | The account controlling a Supplier's staked funds; the default reward recipient. The same owner may have many Suppliers. |
| Revenue-share recipient | An address receiving a configured portion of a Supplier's earnings. It need not be the owner or operator. |
| Endpoint | The public service URL, including its host, path and transport. A Supplier can register endpoints for multiple services. |
| Hostname | The host part of the endpoint, such as `relay.alder.example`. Several Suppliers can use the same host. |
| Domain | A broader name such as `alder.example`, including its recorded subdomains when searching. It does not establish common ownership or a common backend. |
| Fleet / infrastructure group | An explicitly recorded subdivision such as North, South or hosted infrastructure. Hostnames alone do not prove a physical backend. |
| Service / service ID | The registered offering being served, such as Ethereum RPC. One Supplier may serve several services; each service has its own eligible population. |
| Application | The requesting on-chain identity. It is distinct from a software product's name or the end user's identity. |
| Gateway | An intermediary that can route and sign requests for delegated Applications. Traffic mapping requires evidence. |
| Session | A service, Application and block-window assignment of Suppliers. It is the unit used for selection and the earnings comparison here. |
| Relay | An individual service request and response within a session. Session selection does not establish the number of relays served. |
| RelayMiner | Software that handles signed requests, forwards them to a backend, and records work for claims and proofs. Several Supplier identities can share infrastructure. |
| Backend / node | The running software actually answering service requests, such as a blockchain node or model server. It is separate from the on-chain Supplier identity. |
| Source owner | The account registering a service in the service registry. This is a different role from the owner of a Supplier's stake. |
| Eligible / selected | Eligible identities are candidates for a service; selected identities are assigned to a particular session. The scenario assumes uniform sampling without replacement. |
| Gross earnings | POKT attributed to the measured Suppliers across revenue-share recipients, before operating costs. This is not an owner's net profit. |
| Equal-share amount | For each covered session: gross Supplier payout pool × your selected identities ÷ all selected identities. |
| F score / percentage difference | This product's earnings ratio, `actual / equal share`; percentage difference is `(F − 1) × 100`. F = 1.24 and +24% express the same comparison. It is not a protocol quality grade. |
| QoS | Quality of service, such as latency and reliability. This preview's earnings differences do not establish QoS. |
| Session presence | The fraction of verified sessions selecting at least one of the measured Suppliers. It differs from traffic share and from average selected positions. |
| Snapshot / coverage | A fixed saved observation set; coverage measures how much relevant evidence is comparable within that set. Unknowns remain unknown. |

## How the data is partitioned

| Question | Dimensions |
| --- | --- |
| Who is included? | Fleet, Supplier, historical owner address |
| Where are the endpoints associated? | Explicit fleet group, hostname; domain is also a discovery scope |
| What is being served? | Selected service or services |
| Which traffic? | Gateway and Application, with explicit unknown relationships |
| When? | Week and six-hour UTC time windows |
| Which opportunity? | Number of your Suppliers selected; gross session payout-value band |

Filters intersect. A Supplier can appear in multiple hostname/domain groups, so those groups can overlap. Combined service earnings sum POKT amounts; identities are counted once and service F scores are never averaged. In illustrative mode, the network view is an eight-fleet fictional sample. In live mode, it covers the recorded Supplier identities and sampled sessions for the eight collected services; it is not an all-service or all-request network census.

## Official references and Phase 1 boundaries

The protocol terminology was checked against Pocket's [Supplier Staking](https://docs.pocket.network/node-operators/supplier-staking/), [Shannon Architecture](https://docs.pocket.network/protocol/architecture/), [Sessions, Claims & Proofs](https://docs.pocket.network/protocol/sessions-claims-proofs/), and [Services](https://docs.pocket.network/services/) documentation on 8 October 2026. Fleet grouping, F score and the equal-share comparison are product definitions.

The explicit Phase 1 preview uses `demo:` Supplier identities and `.example` endpoints. The live product records actual Supplier operator/owner roles and service-specific endpoints. Gross distributions include configured revenue-share recipients; the fleet totals do not identify personal net receipts or profit. Neither mode infers a business from a hostname or owner address. The separate settlement-first collector uses historical session-end membership and an indexed-settled-session scope; it does not reconstruct registered selection opportunity from claims.

## Live endpoint records

Live discovery now accepts partial names such as Nodefleet and Kleomedes by matching the observed domain/hostname text. Domain groups span recorded owner addresses; business ownership remains unverified. The endpoint drawer exposes scheme, host, port, path, public suffix, registrable domain, literal subdomain tokens and service-specific historical associations. Pocket account encoding and checksums are validated without assigning business or geographic meaning to their payloads. See [the endpoint model](endpoint-model.md) for exact fields, grouping rules and source provenance.
