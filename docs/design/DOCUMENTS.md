# Documents

> **Status: first version built** (2026-10-22). Revisions expected after real use.

## Decided

| Decision | Date |
|---|---|
| A distinct **Documents** page for everything, and documents shown **beside the entries** they belong to in My data (an insurance card on the policy, a license on the ID). | 2026-10-22 |
| **Assistants do the reading.** Little Dipper stores documents; an assistant reads them and proposes structured entries, which the owner accepts. | 2026-10-22 |
| **Expiring share links** for people without a Little Dipper. | 2026-10-22 |
| Drop links (someone without a Little Dipper uploading *to* the owner) are **not needed for now**. | 2026-10-22 |
| Grid is the default library view, with a list toggle. Receipt photos are documents too. | 2026-10-22 |

## Model

- **A document** has a title, a kind (open set: ID document, card, insurance card, receipt, statement, lease, contract, tax form, medical record…), an optional date, **pages** (files: a card's front and back, a multi-page PDF), notes, and text an assistant read from it.
- **Status:** `inbox` (just arrived) or `filed`.
- **Links** to entries in My data, any number of them. The same document appears on each linked entry and in the library: nothing is stored twice.
- Categories that take documents name a default kind (`DomainDef.documents`): IDs → ID document, Insurance → insurance card, Receipts → receipt, Residences → lease, and so on. Their editor gets a Documents section.
- **Deleting an entry** deletes documents linked only to it (a receipt's photo) and unlinks documents linked elsewhere.
- Pages are **encrypted** with the master key and kept apart from the JSON documents. **Backups** copy each page once into `backups/blobs` and restore brings back pages deleted since. **Export:** `GET /api/v1/export/documents` gives a `.tar` of every page with a manifest.

## Ways in

| From | How | Status |
|---|---|---|
| The owner | Upload or drag in on the Documents page (→ inbox), or add from an entry in My data (→ filed on it) | Built |
| Apps and assistants | `POST /api/v1/documents` with a key: `documents:write` for the library, or a category's write scope to file on its entries (a receipts key can file receipt photos) | Built |
| Connected Little Dippers | A message with an attachment (messages already carry an `attachments` field) | Later |
| Organizations | The service API, like merchant receipts | Later |
| Email forwarding | See [MESSAGING-AND-EMAIL.md](MESSAGING-AND-EMAIL.md) | Later |

## Assistants

1. Find new documents: `GET /api/v1/documents?status=inbox` (a notification feed later, so they don't poll).
2. Save what they read: `PATCH /api/v1/documents/{id}` with `text`. The library searches it.
3. Propose entries: `POST /api/v1/documents/{id}/suggestions` with `{ domain, recordId?, data, note }`. Values are validated immediately.
4. **Only the owner accepts** (`.../accept`, browser session only), optionally after editing. The entry records the assistant's key as its source; the document is linked and filed.

This keeps the rule from question 7: AIs write through drafts the owner approves.

## Sharing

- **With people without a Little Dipper:** a link that works for 1 hour, 1 day, 7 days or 30 days, created only from the owner's browser. It shows the pages and who shared them, counts views, logs each one, and can be turned off at once. Only a hash of the secret is stored.
- **With contacts:** not yet. Next step: an "include documents" switch on a category grant, so sharing insurance can include the card scans.

## Not yet

- Documents from contacts (message attachments) and the "include documents" grant switch.
- A notification feed for assistants.
- Text search runs over decrypted text in memory: fine for hundreds of documents, needs an index for thousands.
- Versions (a renewed license replacing the old scan) beyond keeping both linked.
- The export builds the `.tar` in memory; stream it if libraries get large.
