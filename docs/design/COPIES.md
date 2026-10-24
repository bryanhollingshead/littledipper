# Copies: sharing with people who don't use Little Dipper

> **Status: first version built** (2026-10-24): copies of entries as a link, a file or text in an email; a new email address becomes a contact.

Connections share live data with other Little Dippers. Most people the owner deals with (a landlord, a recruiter, a new doctor, an accountant) don't run one. A **copy** covers them: a snapshot of chosen entries, sent the way the owner chooses.

## Decided

| Decision | Date |
|---|---|
| **A copy is a snapshot.** It holds the entries as they were when it was made. Later edits don't reach it. | 2026-10-24 |
| **Files and text don't expire.** PDF, JSON and text copies are the recipient's to keep, and the UI says so plainly. Only links can end or be turned off. | 2026-10-24 |
| **A link is one option, not the main one.** Its value is less certain for data than for documents, but it lets the owner see when a copy is opened and turn it off. | 2026-10-24 |
| **Sending to an email adds a contact** (or finds the existing one by email address). The contact page lists what was sent to them. | 2026-10-24 |
| **The node still doesn't send email.** It writes the message, and the owner sends it from their own mail app (`mailto:`, or copy and paste). See [MESSAGING-AND-EMAIL.md](MESSAGING-AND-EMAIL.md). | 2026-10-24 |

## How it works

- **What:** one or more categories, with entries picked one by one. Notes are never included. Contact links become names. Secret parts are left out unless the owner ticks "Include secret details" and confirms (`confirm_required`, the same rule as grants).
- **How:** `link` (1 day, 7 days, 30 days, or until turned off), `file` (the owner downloads a PDF, JSON or text file to attach), or `inline` (the text goes in the email body).
- **Who:** optional. An existing contact, a new email address (a contact is created), or no one (just a link or a file).
- **Stored:** the `copies` collection. The snapshot is encrypted with the master key, since it may hold secret values. For links, only a hash of the secret is stored. Views and downloads are counted and logged in the activity feed.
- **Formats:** JSON (`little-dipper.copy/v1`), plain text, and a PDF the server writes itself (Helvetica, no dependencies).
- **Deleting a contact** turns off links sent to them and keeps the copies in history. **Delete from history** (`?forget=1`) removes a copy entirely.

## API

Session only (the owner's browser), like document share links: sending data out is an outward-facing act.

- `POST /api/v1/copies` `{ items: [{ domain, recordIds?, includeSecret? }], to?: { contactId? | email, name? }, delivery: link|file|inline, hours?, note?, title?, confirm? }` → `{ copy, url, contact, email: { to, subject, body } }`
- `GET /api/v1/copies?contactId=&domain=`, `GET /api/v1/copies/{id}`, `GET /api/v1/copies/{id}/download?format=pdf|json|txt`
- `DELETE /api/v1/copies/{id}` turns the link off; `?forget=1` deletes the copy.
- Public: `GET /public/v1/copies/{token}` and `/public/v1/copies/{token}/download?format=`. The page is `{address}/c/{token}`.

## Not built

- Sending the email from the node (an optional SMTP relay, as in MESSAGING-AND-EMAIL).
- A passcode on links, given to the recipient separately.
- Copies that update ("keep it current") while the link is open.
- Including linked documents (scans) in a copy.
