# Open Questions

Decisions that haven't been made yet. When one is settled, record the answer and the date, then move it to **Decided**.

| # | Question | Context | Raised |
|---|---|---|---|
| 1 | Is there an *oldest supported release*, or is every release supported forever? | Decides how far back the cross-release peer test and upgrade test must reach. [COMPATIBILITY.md](COMPATIBILITY.md) VII, VIII, X | 2026-10-21 |
| 2 | Do the CLI and environment variables get the same strictness as the HTTP API? | Installers and hosts script against them. [COMPATIBILITY.md](COMPATIBILITY.md) II | 2026-10-21 |
| 3 | Who are the maintainers who can approve a security exception? | Needs at least two people, so the author never signs off on their own break. [COMPATIBILITY.md](COMPATIBILITY.md) IX | 2026-10-21 |
| 4 | How does Big Dipper get deeper access to nodes that opt in to verification? | Options: a limited, revocable API key (`/api/v1/keys` already exists), or acting as a federated peer over `/peer/v1`. Without either, it can only reach the public and peer endpoints. | 2026-10-21 |

| 5 | Should contacts have a local "ID confirmed" mark, separate from Big Dipper verification? | Two different questions. Local: "is this node ID really the person I know?", which only the two people can settle by comparing IDs out of band. Big Dipper: "are this node's identity claims true and unchanged?" The Big Dipper check depends on the local one, since a contact asks about a node ID. Reserve the word **Verified** for Big Dipper. Decide whether a local mark is worth having, and whether a key change should clear it. | 2026-10-21 |
| 7 | How are AIs invited in, and what may they do? | Blocks AI-assisted entry and any MCP tools that write data. Covers drafts and approval, provenance, which scopes AIs get, and where AI processing runs. Owner's view: an AI is a **contact with permissions**. Leading option: show AIs in Contacts with the contact grant controls (fields, domains, current only, secret confirmation), backed by a scoped key that MCP uses, with write access only through drafts. [design/DATA-ENTRY.md](design/DATA-ENTRY.md) | 2026-10-21 |
| 8 | Messaging: the minimal first version's scope, and the organization "service" profile | Direction is agreed (see Decided). Still to settle: sign-off on the first-version scope, and how organization services are verified, identified and limited. Email beyond invites is deferred. [design/MESSAGING-AND-EMAIL.md](design/MESSAGING-AND-EMAIL.md) | 2026-10-21 |
| 9 | Receipts: line items, date-range sharing, and incentive sharing with companies | Line items need a list field type the domain engine doesn't have. Grants need date ranges. Company incentive sharing probably follows the AI-contacts model (7). [design/RECEIPTS.md](design/RECEIPTS.md) | 2026-10-21 |
| 6 | Big Dipper identity verification: who delivers the result to the contact, Big Dipper or the owner's node? | The flow and principles are agreed (see Decided). This part is still open because it decides whether Big Dipper learns who checks up on whom. Other open details are in [design/IDENTITY-VERIFICATION.md](design/IDENTITY-VERIFICATION.md#still-open). | 2026-10-21 |

## Decided

| Decision | Date | Details |
|---|---|---|
| Big Dipper sends every request to share a verification result to the owner for permission, in their own Little Dipper app. Big Dipper never stores ID documents, only the result and salted hashes of the verified values. | 2026-10-21 | [design/IDENTITY-VERIFICATION.md](design/IDENTITY-VERIFICATION.md) |
| Human data entry uses tables, not per-record forms. Little Dipper will be MCP compatible. A documents module (admin and API) is a key upcoming feature. AI-assisted entry waits for the AI invitation design. | 2026-10-21 | [design/DATA-ENTRY.md](design/DATA-ENTRY.md) |
| Receipts will be a built-in domain with file attachments, built after documents. It's for taxes, buying again, warranties, proof of purchase and opt-in incentive sharing. It starts with raw data only; links to other categories come later. Capture: table entry and upload first, then email forwarding, with merchants sending receipts directly much later. | 2026-10-21 | [design/RECEIPTS.md](design/RECEIPTS.md) |
| One inbox, organized by contact. Node-to-node messaging starts minimal, but its data model supports rich messaging later. Organizations won't run nodes: they're verified, added as contacts, and implement a messaging-only API service. Invites stay as they are; other email options come later. | 2026-10-21 | [design/MESSAGING-AND-EMAIL.md](design/MESSAGING-AND-EMAIL.md) |
