# Data Commons (long-term vision)

> **Status: vision only.** Recorded 2026-10-22. Nothing to build yet. See [open question 12](../OPEN-QUESTIONS.md).

## The idea

If self-hosted Little Dippers become common, owners could **choose to contribute anonymized data** (receipts first) to a shared **data commons**, for innovation, socio-economic research and public welfare. The commons might be a pool of aggregated data that AI companies and researchers pay to use, or a model trained on it. Many owners will say no. Some will contribute for the public good, and some only for a financial reward. Both are fine.

## How it fits what exists

- **Contributing is just another grant.** The commons would be a verified organization contact (a service, as in [MESSAGING-AND-EMAIL.md](MESSAGING-AND-EMAIL.md)) that the owner grants a domain to, with the same controls: per domain, revocable, logged in the audit trail.
- **Data stays home by default.** The node decides what leaves and in what form.
- **Rewards** could later be paid into the embedded wallet (question 11).

## Hard parts

**Anonymizing receipts is harder than it looks.** A few purchases with times and places can identify a person, and so can card digits or an unusual item. Removing names isn't enough. Approaches, roughly from weakest to strongest:

| Approach | What leaves the node |
|---|---|
| Strip and generalize | Records with identifiers removed: merchant → category, date → week, city → region, no card or order numbers. Simple, but a leak is still possible. |
| Thresholds (k-anonymity) | Only values shared by at least *k* contributors are released. Needs a trusted aggregator. |
| Local aggregation | The node shares only summaries ("groceries, Oct 2026, $412"), never individual receipts. |
| Federated analytics with differential privacy | Queries go to the nodes; each answers with a noisy aggregate. Raw data never leaves, and there's a provable privacy guarantee. |
| Federated learning | Model training runs on the nodes; only model updates leave, ideally with differential privacy. |

The federated approaches fit the architecture, but the owner doesn't want them (2026-10-22): too complex and too slow to become useful.

### Leading direction: itemized contributions (2026-10-22)

For receipts, the valuable information is narrow: **product code (SKU or GTIN), price and payment method.** That's mostly price-index data, and it can leave the node in a form that's hard to tie back to a person:

| Sent | Not sent |
|---|---|
| SKU / GTIN, quantity, unit price, currency | Merchant name or store, unless it's a large chain (decide later) |
| Payment method *type* (card, cash, stablecoin…) | Card digits, order numbers, notes, photos |
| Week or month of purchase | Exact date or time |
| Region (state or metro area) | Address or city |

Rules that do most of the protecting:
- **Break up the basket.** Each line item is sent on its own, with no receipt id and no contributor id. A whole basket is far more identifying than its parts.
- **Batch and delay.** Nodes send contributions in batches some time after purchase, not as they happen.
- **Rare items stay out.** The commons publishes a product only once enough different contributors have reported it.
- **The owner previews it.** The node shows exactly what would be sent before anything goes.

Open: rewarding contributors without linking their contributions back to them (for example per-batch rewards, or blinded reward tokens).

**Other things to decide:**
- **Consent must be honest.** Owners can stop contributing at any time, but data already aggregated or used to train a model can't be pulled back. The interface has to say so plainly.
- **Governance:** who runs the commons, who may buy access, how money is split, and who audits it. A data cooperative or trust, separate from Big Dipper, avoids one company holding everyone's data. Existing examples to study: MIDATA (Swiss health data cooperative), Driver's Seat Cooperative, and Open Humans.
- **Paying for data invites fake data.** Merchant-signed receipts and Big Dipper verification (proving a real, unique person without revealing who) would make contributions trustworthy.
- **Law:** GDPR's bar for "anonymous" is high, and under CCPA, exchanging data for money can count as a "sale". This needs legal review before any launch.

## What helps now (no extra work)

- Keep schemas stable and structured (the [compatibility commandments](../COMPATIBILITY.md)). Data in a consistent shape across nodes is what makes it useful in aggregate.
- Keep provenance: `capturedVia`, plus record `source` showing who created each record. Merchant-sent receipts will be worth more than typed ones.
- Keep category lists stable. Later, map them to standard codes (for example, GTIN for products) so data compares across nodes.
