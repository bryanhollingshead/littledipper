# Public Profile

> **Status: sections built** on branch `receipts` (2026-10-22). Ideas below are not built.

## Built: sections

The public page is the header (photo, name, headline) plus **sections** the owner adds, orders and configures:

| Section | Shows |
|---|---|
| Details | The profile fields switched on (as before) |
| About | A paragraph in the owner's words |
| Work history, Education, Licenses & certifications, Military service, and other public categories | Entries from My data. The owner picks which parts show (defaults are what a résumé would show), all or current only, and can hide individual entries. New entries appear automatically. |
| Résumé | A document visitors can view and download |

Rules:
- **Secret parts never show**, nor links to the owner's contacts. Only categories marked `publicable` can be sections. The server refuses anything else.
- One function (`publicView`) builds the visitor's page, and the editor's live preview uses its output, so the preview can't drift from the real thing.
- Visitors can open only the profile photo and the résumé's pages, never other documents.
- The photo is also kept as a document (library, backups, export).
- `fields` stays in the public response for older clients (Commandment I).

## Ideas, not built

1. **A résumé generated from your data.** Work history, education and credentials already live in My data, so a "View as résumé" page could lay them out for print or PDF. One source of truth: update a job once and the profile, the résumé and job applications all follow. An uploaded résumé stays an option.
2. **Machine-readable profile.** Publish the same sections as schema.org `Person` JSON-LD on the page, and as JSON Resume at a stable URL. Search engines, recruiters' tools and AI agents read structure instead of scraping.
3. **Audiences.** Different views for different people: the public page stays light, and a private expiring link (like document share links) shows a recruiter or landlord more, such as references, full dates or pay history.
4. **Verified entries.** Once Big Dipper verification exists, a job or degree confirmed by the employer or school gets a badge: "Verified by Big Dipper", with the same owner-permission flow as ID verification ([IDENTITY-VERIFICATION.md](IDENTITY-VERIFICATION.md)).
5. **Links section:** website, portfolio, social profiles.
