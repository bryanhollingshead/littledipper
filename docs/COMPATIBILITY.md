# The Compatibility Commandments

> **Status: draft.** These rules will become binding once the OpenAPI spec and the CI checks in Commandment X exist. Until then, treat them as the direction the project is heading.

Little Dipper has no API versions. No `v2` is coming, and no flag day where every node has to upgrade together. Thousands of independently run nodes, apps built on them and the peers they connect to all need to keep working with each other, whichever release each one runs. The only way to get there is to make every change **additive**, and to enforce that with machines as well as good intentions.

These rules apply to every surface a party other than the code itself depends on:

| Surface | Who depends on it |
|---|---|
| `/api/*` | The web app, owner tools and third-party apps holding API keys |
| `/peer/*` | Other Little Dipper nodes, running any release |
| `/public/*`, `/.well-known/little-dipper` | Anyone on the internet, including Big Dipper's verification |
| Stored data, backups, exports | Future releases of this code, and the people who own the data |
| CLI commands and environment variables | Installers, hosts and operators |

---

## I. There is no version.

Paths carry no version number (`/api/data/receipts`, not `/api/v1/data/receipts`), and none will ever be added. The two things versions usually solve are handled another way:
- **Changing the API without breaking anyone:** every change is additive (Commandment II). Something designed badly gets a better replacement next to it, and the old one keeps working.
- **Knowing what the other side supports:** each node lists its capabilities (Commandment VII).

Clients never compare version strings to decide what a node can do. The `version` field in the node descriptor is only for display and support.

## II. Thou shalt only add.

**Allowed:**
- New endpoints
- New **optional** request fields, whose absence means exactly what it meant before
- New response fields
- New values in enums documented as open (Commandment IV)
- New error codes, for new failure conditions only
- New scopes, new domains, new CLI commands, new environment variables with safe defaults

**Forbidden:**
- Removing or renaming an endpoint, field, parameter, scope, error code, CLI command or environment variable
- Changing a field's type, format or unit (`"42"` → `42`, seconds → milliseconds, a string → an object)
- Making an optional input required, or turning a nullable output non-null or the reverse
- Tightening validation on input that used to be accepted
- Changing the status code or error code returned for an existing outcome
- Changing a default value
- Requiring more auth or a broader scope on an existing route, except under Commandment IX

To change something, add the new thing next to the old one and keep both working.

### The catalog evolves the same way

The built-in domains in `server/src/domains/catalog.ts` are a contract too: records on every node were saved against them, and apps and peers read them.

| Allowed | Forbidden |
|---|---|
| A new domain | Removing a domain, or changing whether it's `dated` |
| A new **optional** part | A new **required** part on an existing domain (old records don't have it) |
| A new enum option | Removing an enum option (records may hold it) |
| New label, hint or description wording | Removing or renaming a part, including a sub-part of a list |
| Marking a part `deprecated: true` | Changing a part's type |
| | Making a part required, or no longer required |

To replace a part, add the new one next to it and mark the old one `deprecated: true`. The old part keeps working; new screens stop offering it.

### How it's enforced

`server/compat/contract.json` records the capabilities, every route and the catalog. `npm run compat -w server` builds the same from the code and fails on anything above that's forbidden, naming the domain and part. CI runs it on every push and pull request against the contract in the commit being built on, so editing the file can't hide a removal. After adding something, run `npm run compat -w server -- --update` and commit the new contract with the change.

## III. Ignore what you don't understand.

- **Clients and peers** must ignore unknown fields in responses. That rule is what makes adding fields safe.
- **Servers** ignore unknown fields in requests. They don't reject them, and they never store them silently.
- Our own clients (the web app, the CLI and peer code in `federation.ts`) must follow the same rule. Tests should feed them responses with extra fields.

## IV. Enums are open unless sworn closed.

Every enum in the spec is labelled **open** or **closed**.
- **Open** (for example `connectRequests`, audit `action`, `tone`): new values may be added, and clients must handle unknown values without crashing, usually with a generic fallback.
- **Closed**: can never gain a value. Use this label rarely, and only where a new value would make old clients behave dangerously.

## V. Meaning is part of the contract.

A field that keeps its name and type but changes meaning is a breaking change. The same request must keep doing the same thing, with the same side effects. If the behavior needs to change, add an opt-in (a new field, parameter or endpoint) and leave the old behavior as the default.

## VI. Errors have a stable `code`, not a stable `message`.

The error shape `{ code, message }` is frozen. `code` is part of the API. `message` is for humans and may change at any time. Clients branch on `code` and never on `message`. A `code` that has been returned once must keep meaning the same thing.

## VII. Detect features, never versions.

Different releases constantly talk to each other over `/peer`. A node must:
- Work with peers running **any earlier release** that is still out in the world, which in practice means all of them.
- Advertise what it supports as a list of named **capabilities** in `/.well-known/little-dipper`, and check the peer's list before using a newer feature. Apps and skins do the same.
- Fall back gracefully when a peer lacks a capability. A missing capability is not an error.
- Never remove a capability once it has been advertised.

### Capabilities are not permissions

| | Capabilities | Grants |
|---|---|---|
| Answers | What can this node's software do? | What may *this contact* see or do? |
| Where | `/.well-known/little-dipper`, public | `/peer/domains` and friends, signed requests only |
| Varies by | Release: every node on a release lists the same names | Relationship: different for every contact |
| Changes | Only grows | Whenever the owner grants or revokes |

The capability list never describes the owner's data: not which domains hold records, not counts, not custom categories. A capability isn't an offer: `calendar.share` means the software can share calendars, not that this owner shares theirs with you. Before using a feature with a peer, check both: the peer's capability, then the grant.

### The capabilities

| Name | Means |
|---|---|
| `records` | Records live at `/api/data/{domain}`; peers read granted domains at `/peer/domains/{domain}` |
| `records.history` | Earlier versions and deleted records at `/api/data/{domain}/{id}/history` and `/api/data/{domain}/deleted` |
| `records.provenance` | Records carry `updatedBy` and `updatedByLabel` |
| `parts.datetime` | The `datetime` part type: `{ at, tz }` |
| `calendar` | `GET /api/calendar` gathers dated items across domains |
| `calendar.share` | Events can be granted to contacts and appear in their calendar |
| `documents` | Documents and their pages at `/api/documents` |
| `documents.share-links` | Documents can be shared by link (`/public/shared/{token}`) |
| `copies` | Copies sent to contacts at `/api/copies` |
| `messages` | Accepts messages at `/peer/messages` |
| `address-change` | Accepts `/peer/address-change` when a contact moves |
| `backups.device` | Backups can be downloaded to the owner's device |
| `recovery-kit` | `POST /api/node/recovery-kit` produces a kit |
| `restore` | A fresh node can be restored from a kit and a backup at `POST /api/node/claim/restore` |
| `mcp` | An MCP server (Streamable HTTP, stateless) at the descriptor's `mcp` address, for AI assistants using an app key |
| `assistants` | App keys can carry an assistant mode (answer, suggest, make) and readable secret fields; suggested changes wait at `/api/reviews` for the owner |

The list lives in `CAPABILITIES` in `server/src/node.ts`.

## VIII. Upgrades never lose data, and no release is skipped over.

Upgrades are the hardest layer in this design, so the rules here are the strictest:
1. **Migrations run forward, are idempotent and run at boot**, as `server/src/migrate.ts` does today. Running a migration twice gives the same result as running it once.
2. **A release must boot on data written by any earlier release.** Operators may jump straight from a very old release to the latest, so required intermediate upgrades are not allowed.
3. **Never destroy what you can't convert.** If a value can't be migrated safely, leave it exactly as it was. The existing migration does this: an address it can't parse stays a plain field.
4. **Stored data is additive too.** You may add collections and fields. You may not reinterpret existing stored values in place. Write new fields and derive from them instead.
5. **Back up before every update.** `POST /api/node/update` already takes a `pre-update` backup. Every update path, including host-managed ones, should do the same.
6. **Backups and exports from any release must restore or import into any later release.**
7. **Rollback means restoring the pre-update backup.** We don't promise that older code can read data written by newer code, so the backup must always exist.

## IX. Security is the only exception.

A change that breaks compatibility is allowed only to fix a security vulnerability, and then only with all of the following:
- The smallest possible break
- A written advisory explaining what changed and why
- Maintainer sign-off from someone other than the author
- A note in the release notes that operators and app developers will see

"It's cleaner" or "nobody uses it" do not qualify.

## X. The machine is the judge.

These rules only work if CI enforces them:
- **The OpenAPI spec is the contract.** It lives in the repo, and every PR that changes an API surface changes the spec in the same PR.
- **A breaking-change check runs on every PR.** It diffs the spec against `main` (for example with `oasdiff breaking`) and fails on anything Commandment II forbids.
- **Contract tests** run the server against the spec (for example with Schemathesis), so the code can't drift away from it.
- **A cross-release peer test** runs the smoke test with node A on the current `main` and node B on the oldest supported release, in both directions.
- **An upgrade test** restores fixture data from old releases, boots the current code and checks that nothing was lost.
- **Deprecation is documentation, not removal.** Mark a field `deprecated: true` in the spec, point to its replacement, and keep it working.

Big Dipper's opt-in verification will check nodes against the same spec. The rules contributors follow and the rules nodes are verified against are therefore one standard.

## XI. The API is the only front door.

People will build their own skins: other UX kits and apps that replace or sit beside the bundled admin. So the bundled web app gets **no private channel**:
- **Everything it does, it does through the documented API.** No server-rendered pages, no internal-only endpoints, no reading the store directly.
- **Logic a skin would need lives on the server.** Validation, privacy rules (what may be public or shared), derived values and anything security-relevant are enforced by the API, never only in the UI. The UI may add convenience (shrinking photos, totals on screen), but a skin that skips it must still get correct, safe results.
- **Words and choices come from the API where they're data:** category labels, parts, enum options, document kinds, section titles. A skin shouldn't have to copy lists out of our UI code.
- **Public URLs the server hands out are a contract.** Share links (`/s/{token}`), invite links (`/connect?invite=`) and claim links (`/claim`) are routes any skin served by the node must answer.
- **Test it like a skin would:** the smoke test drives only the HTTP API.

---

## Gaps today

The current code doesn't meet these rules yet in a few places:

- [ ] No OpenAPI spec exists yet.
- [ ] Routes have no Fastify request or response schemas, so there's nothing to diff or validate against.
- [ ] Unknown request fields: current behavior is unverified.
- [x] CI runs a breaking-change check on the catalog, capabilities and routes (`server/compat/contract.json`), plus typecheck and the smoke test.
- [ ] The check doesn't yet cover request and response fields or error codes: that needs the OpenAPI spec.
- [ ] No contract tests, cross-release peer test or upgrade test in CI.
- [x] v0.2.0 is the compatibility baseline: the first published release.
- [ ] Skins on another origin can't sign in: there's no CORS and no way for a skin to ask the owner for access (question 14).
- [ ] 28 routes accept only the owner's browser session (security settings, share links, accepting suggestions…), so a skin with an app key can't offer them.
- [ ] Some data lists still live in the bundled UI (public-profile section titles, category blurbs) instead of the API.
- [ ] The endpoint reference is hand-written in the web app (`web/src/reference.ts`) instead of served from the OpenAPI spec.

## Open questions

Still to decide: whether there is an oldest supported release, whether the CLI and environment variables get the same strictness as the HTTP API, and who the maintainers are who can approve a security exception.
