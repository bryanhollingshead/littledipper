# Receipts

> **Status: first version built** (2026-10-22). Receipt photos are stored as documents ([DOCUMENTS.md](DOCUMENTS.md)).

## Built (first version)

- **The `receipts` domain** (Money group): `/api/v1/receipts`, `receipts:read` and `receipts:write` scopes, contact grants. **No part is required:** a photo alone is a receipt, and the details can be filled in later by hand or by an assistant.
- **A new `list` part type in the domain engine:** rows of sub-parts. Receipts use it for line items (item, quantity, price, product code). Up to 200 rows; blank rows are dropped.
- **Photos and PDFs are documents** ([DOCUMENTS.md](DOCUMENTS.md)) of kind `receipt`, linked to the receipt. Deleting the receipt deletes its photo. Contacts a receipt is shared with get the details and line items, not the photos (yet).
- **Return-by and warranty-until** are `remind` dates: they appear on Home and in My data's "Coming up", then drop off two weeks after they pass.
- **Receipts page** (`/admin/receipts`, in the sidebar): upload or drag and drop several at once (each becomes a receipt; one opens straight in the editor), a "needs details" list, filters by year, search, spending by year and by category (totals kept per currency), and a CSV download for an accountant. Large photos are shrunk to 2000px in the browser before upload.
- **Ready for assistants:** an app key with `receipts:read` and `receipts:write` can create a receipt, file its photo on it (`POST /api/v1/documents?link=receipts:…`) and fill in the details, with `capturedVia: "assistant"`. How AIs are invited is still question 7.

### Not yet

- Date-range grants (question 9).
- Linking a receipt to a financial account, or to an item in Property & valuables.
- Email forwarding, extraction and merchant delivery (below).

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
| Line items | Description, quantity, price, product code. Needed for buying again. Built with the new `list` part type. |
| Category | Free text or a short list, for taxes |
| Return by, warranty until | Dates |
| File | Photo or PDF (documents module) |
| Source | Manual, upload, forwarded email or sent by a merchant |

## How receipts get in

1. **Table entry and upload** (first). Type receipts in the table view, or upload a photo or PDF and fill in the details.
2. **Forwarding email receipts.** Forward to an address that feeds your node. Needs incoming email, see [MESSAGING-AND-EMAIL.md](MESSAGING-AND-EMAIL.md).
3. **Extraction.** Pull the details out of photos and emails automatically. Deferred with the rest of AI-assisted entry (question 7).
4. **Merchants sending receipts directly** (much later). A merchant is a verified organization contact running a messaging **service** ([MESSAGING-AND-EMAIL.md](MESSAGING-AND-EMAIL.md)). It sends a signed message of kind `receipt`; the owner's node files it as a receipt with `capturedVia: "merchant"`. The owner can turn this on per merchant, and disconnecting stops it. An app key limited to `receipts:write` is the simpler stopgap.

## Later: invoices and payments (seeds only)

The owner wants companies to be able to send **invoices**, and to pay them from an embedded **stablecoin wallet** or **bank account**. Not designed. What's already in place, so it can grow without breaking changes:
- Organizations reach people as verified contacts over the messaging service, and message `kind` is an open set, so `invoice` and `payment_receipt` can be added as new kinds.
- A paid invoice naturally becomes a receipt; `paymentMethod` already includes `crypto` (Crypto / stablecoin).
- See question 11 for what needs deciding: custody, regulation, which rails, and how a payment is confirmed.

## Open

- Sharing receipts for a date range (for example "last tax year" with an accountant). "Current only" grants don't make sense for receipts.
- Incentive sharing with companies: how a company asks, what it gets (selected fields, aggregate totals?), how long access lasts, and how it's revoked. Probably the same model as AI contacts (question 7).
- Volume: hundreds of receipts a year, each with a file, affects storage, backup size and table performance.
