# Backups: keeping a life's records safe

> **Status: device backups built** (2026-10-30): nightly encrypted backups on the node, one-file backups saved to the owner's device (download, or automatically to a folder they choose), weekly reminders, and restore from a file on new hardware. Other destinations are options for later, below.

If people own their data, a dead disk, a closed hosting account or a lost server can't mean losing their records. Backups have to leave the node, and doing so has to be easy enough that people actually do it.

## Decided

| Decision | Date |
|---|---|
| **Backups are encrypted before they leave the node**, with the node's master key. Wherever a copy goes, that place sees only scrambled data; the question is convenience, not trust. | 2026-10-21 |
| **For the friends-and-family beta, backups go to the owner's own device.** A download any time, automatic saving to a chosen folder where the browser allows it, and a weekly reminder until a copy has reached a device. Other destinations come later. | 2026-10-30 |
| **A synced folder is the easy route off the computer.** Choosing a folder that iCloud Drive, Dropbox or OneDrive syncs takes backups off the machine with no extra setup or credentials. | 2026-10-30 |
| **A backup isn't done until it can be restored.** One file holds the data and every document file, and `little-dipper restore-backup` brings it back on new hardware after the recovery kit. | 2026-10-30 |

## How it works

### On the node

- **Nightly at 03:00** (and before updates, restores and resets), the node takes a backup: every collection except `backups` and `challenges`, encrypted with the master key, in `<dataDir>/backups/`. Kept 30 days.
- **Document files** are stored encrypted already. Each is copied once into `backups/blobs/` and shared by every backup that needs it.
- **Restoring on the same node** (Settings → Backups → Restore) takes a safety backup first, then puts everything back as it was.

### On the owner's device

- **One file per backup:** `little-dipper-YYYY-MM-DD-HHMM.ldbackup`, a JSON file holding `format: "ldbackup"`, the node ID, when it was taken, the encrypted data, and the document files it needs (base64). Unreadable without the recovery kit.
- **Download** (any browser): Settings → Backups → *Download a backup now* takes a fresh backup and downloads it. Each backup in the list also has *Download*.
- **Automatic saving to a folder** (Chrome and Edge, through the File System Access API): the owner picks a folder once. While the app is open, it checks every 30 minutes and saves any newer backup there, keeping the newest 14 files it wrote and removing older ones. The folder choice is this browser's, kept in its IndexedDB, not on the node.
- **When the browser forgets the permission** (common after a restart), saving pauses. Home shows *Allow saving backups to …*, and one click resumes it.
- **Reminders:** the node records when a backup last reached a device (`lastDeviceCopyAt`, `via: download | folder`). After 7 days without one, `deviceBackup.due` is true and Home's *Needs you* asks for a fresh copy. Any skin can show the same reminder from `GET /api/v1/node`.

### Restoring on new hardware

1. Install Little Dipper on the new server, without starting it.
2. `little-dipper restore-kit <file.ldkit>` brings back the identity (it asks for the kit's passphrase).
3. `little-dipper restore-backup <file.ldbackup>` brings back everything else: data and document files. It refuses if the backup belongs to a different node, or if the node already has an owner.
4. Start the server and sign in as before. Contacts find the node at its new address once it sends an address-change notice.

The recovery kit is the real point of failure. Without the kit and its passphrase, every backup, wherever it is, stays unreadable. Settings says so wherever backups are explained.

## API

Session only (the owner's browser): backups hold everything.

- `GET /api/v1/node/backups` → `{ items, schedule, destination, deviceBackup }`
- `POST /api/v1/node/backups` → a new backup
- `GET /api/v1/node/backups/{id}/download?via=download|folder` → the `.ldbackup` file; records the device copy
- `POST /api/v1/node/backups/{id}/restore` → restore on this node
- `GET /api/v1/node` → includes `deviceBackup: { lastAt, via, remindAfterDays, due }`

## Options for later

What else a backup could go to, and how each would feel to an owner. All of them carry the same encrypted file; none can read it.

| Option | The owner's experience | For it | Against it |
|---|---|---|---|
| **Their own S3-compatible storage** (Backblaze B2, Cloudflare R2, AWS) | Paste a bucket and keys into Settings | Standard and cheap; one implementation covers many providers, and Big Dipper's own service could reuse it | Creating a bucket and keys is beyond most non-technical people |
| **Big Dipper backup** | One switch: "Back up to Big Dipper" | The most mainstream option | Big Dipper doesn't exist yet; a dependency, though it only ever holds scrambled data |
| **A consumer cloud drive through its API** (Google Drive, Dropbox) | "Connect Google Drive" | Familiar | App review takes time; iCloud has no usable API; a synced folder already gives most of this |
| **A trusted contact's node** (peer backup) | "Keep a copy with Theo" | Fits a friends-and-family network: your circle keeps each other safe | Storage limits and agreements between nodes; the friend's node must be online to restore |
| **The host's own snapshots** (Render disk snapshots, Railway volume backups) | Usually just on | Free, no work | Tied to the same hosting account; differs by host; whole-disk only |

Also for later:

- **How often:** nightly plus "Back up now" is enough for data that changes a few times a day. Streaming every change (Litestream to S3) loses minutes instead of a day, but adds a second program to every install.
- **Keeping the kit safe:** a printable paper kit with a QR code; splitting the key among trusted contacts so that, say, any 3 of 5 can restore it.
- **Restoring from the setup screen:** a fresh node offering "Restore from a backup" next to claiming, so new hardware needs no command line (BRY-39).

## Still open

- Which destination comes first after beta.
