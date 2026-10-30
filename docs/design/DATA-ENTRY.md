# Data Entry

> **Status: direction agreed, not implemented.** Recorded 2026-10-21.

## Problem

Several domains need a lot of clicking and navigating to fill in. Every record goes through the same side panel, one at a time: open the domain, **Add**, fill in the main fields, expand **More details**, set dates, save, repeat. The panel is `RecordEditor` in `web/src/life.tsx`. There are 24 domains. Entering ten years of residences or a full work history means dozens of round-trips through the panel. The API has the same limit: one record per `POST /api/v1/data/{domain}`.

Both humans and AIs will fill in much of this data, so data-entry UX needs serious design attention.

## Decided

| Decision | Date |
|---|---|
| **Human entry uses a table, not a form.** History domains (residences, employment, education…) get a spreadsheet-like table: keyboard-first, add rows inline, no side panel per record. | 2026-10-21 |
| **Little Dipper must be MCP compatible,** so AI assistants can work with an owner's data through scoped API keys. | 2026-10-21 |
| **A documents module is a key upcoming feature,** covering both the admin screens and the API endpoints. It will be designed soon. | 2026-10-21 |
| **AI-assisted entry (document extraction, pasting a résumé and so on) is deferred** until we've designed how AIs are invited in and what they're allowed to do. | 2026-10-21 |
| **The AI-training feature is removed for now.** The main AI use case is *access*: inviting in a trained AI and granting it scoped, revocable access, like any app or contact. Training (a bulk export so someone can train their own model) is valid but less pressing. If it returns, it should be a deliberate export (who it's for, which domains, off by default), not per-record and per-domain flags. | 2026-10-21 |

## Table entry (next)

Ideas to work through when designing it:
- A table view per domain, with one column per part. The required and title parts come first, and less common parts can be shown or hidden.
- Tab and Enter move between cells. A blank row at the bottom adds a new record.
- Smart defaults: a new residence's start date fills in the previous one's end date, and "current" applies only to the newest row.
- The side panel stays for rare cases: secret parts and notes.
- Secret parts stay masked in the table and are revealed per cell, as in the panel today.
- Benchmark tasks (count clicks before and after): *enter 10 years of addresses*, *enter a 5-job work history*, *add a passport*.

## MCP

Still to design:
- Which tools and resources the MCP server exposes: read and search records, write records, list domains.
- How it's authenticated: reuse API keys and scopes (`records:read`, `{domain}:write`…), so the owner controls what an AI can see and change.
- Where it runs: built into the node (a reserved `/api/v1/mcp` path) or as a separate package that calls the REST API.
- Depends on the AI invitation design below for anything that writes data.

## Documents module

To design soon. Admin screens and endpoints for storing documents (scans, PDFs) and linking them to records, for example a passport scan to an `ids` record or a lease to a residence. Points to settle:
- Storage: the local disk or object storage, encryption at rest and size limits.
- How documents link to records and fields. `FieldDoc.type` already includes `'document'` and `publicProfile.avatarFileId` already references files, but no file storage exists yet.
- Sharing: whether grants cover documents, and how documents travel to peers.
- Inclusion in backups and exports, and the effect on backup size.
- Compatibility: everything additive, per [COMPATIBILITY.md](../COMPATIBILITY.md).

## Deferred: AI-assisted entry

Not until the AI invitation design exists. Captured from the discussion so far:
- **Drafts:** AI- or app-created records go in as *proposed* and need the owner's approval before they're live or shared.
- **Provenance:** each record keeps who or what entered it and from what source.
- **"Paste or drop anything":** extract a résumé or lease into draft records across several domains, then review them all in one list.
- **Batch writes:** one API call that creates many records across domains, with per-record results.
- **Where the AI runs:** an explicit owner setting (a chosen provider or a local model) that states clearly what leaves the node.

## Route names

Custom domain ids always start with `x_` (a custom "Documents" becomes `x_documents`), so owners can't take a name a future module needs. The remaining risk is a **built-in** domain added in code using the same id as a fixed route such as `/api/v1/documents`. A test that checks built-in domain ids against the registered routes would catch that.
