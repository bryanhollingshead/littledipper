#!/usr/bin/env node
/**
 * little-dipper CLI. Whoever can run a command on the server is the deployer.
 *
 *   little-dipper claim-link [--qr]   print a fresh 60-minute claim link (invalidates earlier ones)
 *   little-dipper status              show identity, address and claim state
 *   little-dipper restore-kit <file>  restore the node identity from a recovery kit
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { config } from './config.js';
import { ctx } from './ctx.js';
import { decryptWithPassphrase, nodeIdFromPublicKey } from './crypto.js';
import { loadKeystore, saveKeystore } from './keystore.js';
import { attachNode, canonicalUrl, issueClaimLink } from './node.js';
import { openStore } from './store/index.js';

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  ctx.store = await openStore(config, (m) => console.error(m));
  try {
    switch (cmd) {
      case 'claim-link': {
        const n = await attachNode();
        if (n.claimed) {
          console.log('This Little Dipper is already claimed. To hand it to someone else, use Settings → Security → Transfer ownership.');
          return;
        }
        const { url, expiresAt } = await issueClaimLink();
        console.log(`\nClaim this node: ${url}\n(expires ${new Date(expiresAt).toLocaleTimeString()} · earlier links no longer work)\n`);
        if (args.includes('--qr')) console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
        return;
      }
      case 'status': {
        const n = await attachNode();
        console.log(JSON.stringify({ nodeId: n._id, address: canonicalUrl(n), claimed: n.claimed, version: n.version, store: ctx.store.kind }, null, 2));
        return;
      }
      case 'restore-kit': {
        const file = args[0];
        if (!file) throw new Error('Usage: little-dipper restore-kit <file.ldkit>');
        if (await loadKeystore(ctx.store)) throw new Error('This server already has an identity. Restore onto a fresh data directory / database.');
        const kit = JSON.parse(readFileSync(file, 'utf8'));
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const pass = await rl.question('Recovery kit passphrase: ');
        rl.close();
        const secret = JSON.parse(decryptWithPassphrase(pass, kit));
        if (nodeIdFromPublicKey(secret.signing.publicKey) !== kit.nodeId) throw new Error('Kit is corrupt: key does not match its ID');
        await saveKeystore(ctx.store, { signing: secret.signing, masterKey: secret.masterKey });
        console.log(`Restored identity ${kit.nodeId}. Restore a backup or start the server; contacts will find you at your new address once you send an address-change notice.`);
        return;
      }
      default:
        console.log('Usage: little-dipper <claim-link [--qr] | status | restore-kit <file>>');
    }
  } finally {
    await ctx.store.close();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
