# Little Dipper

A self-hosted personal data store. Each person runs their own instance; the owner has full admin access, and everyone else sees only what the owner chooses. *Your data, not your definition.*

This is the v1 implementation of the **Little Dipper** design (Claude Design project, `Little Dipper.dc.html`): claim, sign-in, the owner app, the public profile, and instance-to-instance connections.

```
server/   Node + TypeScript (Fastify) REST API, peer protocol, CLI
web/      React (Vite) SPA; talks to nothing but the REST API
```

## Run it locally

Node 20+ (Node 22 recommended).

```sh
npm install
npm run dev            # API on :4000, web app on :5173 (proxied to the API)
```

The server prints a claim link on first boot:

```
[little-dipper] Claim this node: http://localhost:4000/claim?token=ct_…
```

In development, pages on :4000 redirect to the web app on :5173 (`LD_WEB_DEV_URL`), so claim, share and copy links work as printed. Passkeys need a real browser on `localhost` or https.

Data lives in one SQLite file, `little-dipper.db`, in `./data` (`LD_DATA_DIR`). There is no database server to run. A node from before SQLite moves its `store.json` across on first start and keeps the old file as `store.json.migrated`.

Lost the link, or it expired (1 hour)?

```sh
npm run claim-link               # prints a fresh link and invalidates earlier ones
npm run cli -w server -- claim-link --qr
```

### Production build

```sh
npm run build && npm start       # serves the API and the built web app on :4000
```

### Tests

```sh
npm run smoke -w server
```

The smoke test starts two instances, claims both with a software passkey, then runs sign-in (passkey and recovery code), Secret field masking and reveal, the public profile, an invite-link connection, the basic profile and per-field grants (Secret grants need confirmation), token rotation, disconnect, API-key scopes, backup and export.

## Configuration

| Variable | Default | |
|---|---|---|
| `LD_PUBLIC_URL` | provider hostname, else `http://localhost:$PORT` | The host address. Configuration, never hard-coded. Detected automatically on Render, Railway and Fly. |
| `PORT` | `4000` | |
| `LD_DATA_DIR` | `./data` | The SQLite database, file contents, keystore (file mode) and encrypted backups. Must be a persistent disk. |
| `LD_KEYSTORE_KEY` | unset | Stores the node identity in the database, encrypted with this key, instead of in `keystore.json`. The key stays in the host's secret settings, off the disk. |
| `LD_CLAIM_TOKEN` | unset | Lets an installer pre-generate the first claim token and open `/claim?token=…` itself. |
| `LD_DEPLOY_HOOK_URL` | unset | Enables **Update now** (e.g. a Render deploy hook). A backup is taken first. |
| `LD_UPDATE_FEED_URL` | unset | JSON `{ version, notes }` for the latest release. |
| `LD_ALLOW_HTTP_PEERS` | auto on localhost | Allow `http://` peers (development only). |
| `LD_WEB_DEV_URL` | unset (`npm run dev` sets `http://localhost:5173`) | Development only: page requests redirect to the Vite dev server. |

## Deploy

- **Render**: `render.yaml` (Docker runtime, generated `LD_KEYSTORE_KEY`, 1 GB disk for the database and backups). The claim link is in the service logs.
- **Docker**: `docker compose up -d`, then `docker logs little-dipper | grep claim`. Expired? `docker exec little-dipper little-dipper claim-link`.
- **VPS**: `npm run build`, run `node server/dist/server.js` under systemd, and use `little-dipper claim-link` (the `bin` in `server/package.json`) with the same environment.

## Data model: domains

Personal data is organised into **domains**, one per category. Each domain has its own endpoint (`/api/v1/data/{domain}`), its own grant in the contact admin and its own app-key scopes (`{domain}:read`, `{domain}:write`; `records:read`/`records:write` cover every domain).

| Group | Domains |
|---|---|
| Identity | `names`, `ids` (government IDs), `citizenship`, `contact_methods` |
| Life | `residences`, `relationships`, `pets`, `travel`, `life_events` |
| Work | `employment`, `education`, `credentials`, `military` |
| Health | `health`, `insurance` |
| Money | `financial_accounts`, `income`, `tax_returns`, `legal` |
| Things | `vehicles`, `property`, `memberships`, `online_accounts` |
| Personal | `preferences` |

- **Definitions** live in `server/src/domains/catalog.ts`: parts, types, sensitivity, whether records are dated and the display title. Owners can add their own categories (`POST /api/v1/catalog`, ids `x_…`).
- **Records** are one JSON document each in the `records` collection, with `validFrom`/`validTo` partial dates (`2019`, `2019-06`, `2019-06-14`). "Current" means no end date.
- **Secret parts** (ID numbers, pay, account details…) are encrypted one by one, masked in the API, and revealed only through a logged call.
- **One source of truth**: the profile's Current address, Current city and Country of residence mirror the current residence; Email and Mobile phone mirror the primary contact methods.
- **Sharing**: grant a contact a whole domain, either every record or current only. Secret parts are shared only with explicit confirmation. Peers read `GET /peer/v1/domains/{domain}`.
- **Copies**: for people without a Little Dipper, send a snapshot of chosen entries as a link (which can expire), a PDF/JSON/text file, or text in an email. A new email address becomes a contact. See [docs/design/COPIES.md](docs/design/COPIES.md).
- **Timeline**: `GET /api/v1/timeline` merges every dated record across domains.

Card and bank numbers are stored as the last four digits only, and the model has no place for passwords.

## How it works

- **Claiming**: on first boot the node creates an ed25519 identity, `ldn_` + base32(sha256(publicKey)), and a one-time claim token. Only the token's sha256 is stored. Setup has four steps: Verify link → You → Sign-in → Done. Claiming deletes the token, and the setup routes stop answering.
- **Sign-in**: passkeys (WebAuthn). Fallback is a password (argon2id) plus an authenticator code (TOTP), set up in Settings → Security. There are 8 single-use recovery codes, stored hashed.
- **Sessions and keys**: browser sessions, app keys and peer tokens share one `apiKeys` shape. Only a hash and a display prefix are stored. The browser session holds `admin:*`; app keys carry scopes (`owner:read`, `contacts:write`, …).
- **Fields**: each field is Standard, Sensitive or Secret. Secret values are AES-256-GCM encrypted at rest, masked in the API, never public, and every reveal is audited.
- **Connections**: every peer→peer write is a signed envelope (ed25519 over canonical JSON, with a timestamp and a nonce for replay protection). Request → accept exchanges scoped bearer tokens both ways. Peers read `GET /peer/v1/profile` (the basic profile) and `GET /peer/v1/fields` (per-field extras). Rotate, disconnect and address-change are signed messages too. Requests are allowed by `connectRequests` (`off` / `fof` / `anyone`) or by a single-use invite link.
- **Addresses**: the canonical address is a verified custom domain, otherwise the host address. Changing it sends `/peer/v1/address-change` to every connection. Retired domains redirect for 90 days.
- **Backups**: nightly at 03:00, encrypted with the node's master key, kept 30 days. A recovery kit (passphrase-encrypted signing key + master key) restores the same identity on new hardware (`little-dipper restore-kit <file>`), then `little-dipper restore-backup <file.ldbackup>` brings back the data. Settings → Backups saves `.ldbackup` files to the owner's device and reminds them weekly until one has.

**Settings → Show technical details** turns on the Build reference pages (Data model, Endpoints) and the API Explorer.

## Not built yet / known gaps

- Big Dipper itself doesn't exist yet. Settings → Big Dipper presents the services and saves the owner's choices; connecting works once `LD_BIG_DIPPER_URL` is set. The API docs site is out of scope, and **API docs** is a stub.
- The "people my contacts know" (`fof`) check uses hashed mutual-contact hints supplied by the requester. These are not yet cryptographically verified.
- The recovery kit holds the signing and backup keys, but not recovery codes, which are only ever stored hashed.
- Backups stay on the node and on the owner's device (download, or a chosen folder in Chrome and Edge). Other destinations such as S3 or Big Dipper are not built yet; see [docs/design/BACKUPS.md](docs/design/BACKUPS.md).
- Requests can't ask for specific fields from the UI yet. The protocol supports `requestedFields`.

## Docs

See [docs/README.md](docs/README.md) for the compatibility rules and design notes.

## License

Little Dipper is free software under the [GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`). You may run, study, change and share it. If you run a modified version as a service for other people, you must offer them its source code under the same license.

The license covers the code. It gives no rights over anyone's data: what an owner keeps on their node is theirs.
