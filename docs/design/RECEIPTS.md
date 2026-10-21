# Receipts

> **Status: requirements agreed, not designed or built.** Recorded 2026-10-21. Build after the documents module ([DATA-ENTRY.md](DATA-ENTRY.md#documents-module)).

## Why owners keep receipts

- **Taxes:** deductible purchases, business expenses, records to hand an accountant.
- **Buying again:** what was bought, where, and for how much.
- **Warranties:** what's covered and until when.
- **Proof of purchase:** returns, insurance claims, ownership.
- **Incentives for sharing (opt-in):** owners may choose to share receipt data with companies in return for rewards. It's always the owner's choice, through the normal grant model.

## Approach

**Start with raw data only. Add smarts later.** Capture the receipt and its basic details. Links to other categories (Property & valuables, tax returns, insurance), analysis and spending reports all come later.

- **A built-in domain, `receipts`.** It automatically gets `/api/v1/receipts` endpoints, `receipts:read` and `receipts:write` scopes, contact grants and the table entry view.
- **Each receipt can have a file attached**, a photo or PDF stored through the documents module.
- **Return-by and warranty-until dates** feed the Home "needs attention" list, as expiring IDs already do.

### Raw fields (first pass)

| Field | Notes |
|---|---|
| Merchant | Name, plus website if known |
| Purchase date | |
| Total, subtotal, tax | Money with currency |
| Payment method | Type and card last 4 digits only |
| Order or receipt number | |
| Line items | Description, quantity, price, product code. Needed for buying again. **Open:** domains only support flat fields today, so this needs a list or table field type. |
| Category | Free text or a short list, for taxes |
| Return by, warranty until | Dates |
| File | Photo or PDF (documents module) |
| Source | Manual, upload, forwarded email or sent by a merchant |

## How receipts get in

1. **Table entry and upload** (first). Type receipts in the table view, or upload a photo or PDF and fill in the details.
2. **Forwarding email receipts.** Forward to an address that feeds your node. Needs incoming email, see [MESSAGING-AND-EMAIL.md](MESSAGING-AND-EMAIL.md).
3. **Extraction.** Pull the details out of photos and emails automatically. Deferred with the rest of AI-assisted entry (question 7).
4. **Merchants sending receipts directly** (much later). A company could push receipts to a node with an app key the owner issues, limited to `receipts:write`, ideally landing as drafts.

## Open

- Line items: add a list or table field type to the domain engine, or store them another way.
- Sharing receipts for a date range (for example "last tax year" with an accountant). "Current only" grants don't make sense for receipts.
- Incentive sharing with companies: how a company asks, what it gets (selected fields, aggregate totals?), how long access lasts, and how it's revoked. Probably the same model as AI contacts (question 7).
- Volume: hundreds of receipts a year, each with a file, affects storage, backup size and table performance.
