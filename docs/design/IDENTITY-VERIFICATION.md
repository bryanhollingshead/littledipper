# Identity Verification via Big Dipper

> **Status: design agreed in principle, not implemented.** Recorded 2026-10-21. Big Dipper doesn't exist yet. Build this when it does.

## Purpose

Before a sensitive transaction, a contact may want to know whether a Little Dipper owner's identity claims (legal name, date of birth and so on) have been checked by a trusted third party, and whether they still match the profile today. Big Dipper provides that check as an opt-in service.

## Two separate questions

| | Question | Who answers |
|---|---|---|
| **ID confirmation** (local) | Is node `ldn_…` really the person I know? | The two people, by comparing node IDs out of band (in person or over a call) |
| **Identity verification** (Big Dipper) | Are the identity claims on node `ldn_…` true, and unchanged since they were checked? | Big Dipper |

Verification depends on confirmation: a contact asks about a **node ID**, so they need to be sure it's the right one. The word **Verified** in the product is reserved for Big Dipper results. See [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md) question 5 for the local mark.

## Flow

1. **The owner opts in** and completes verification with Big Dipper (document check, liveness and so on).
2. **Big Dipper issues a signed result**, bound to the owner's node ID and signing key, and stores it. It keeps no ID documents (see the principles below).
3. **A contact asks** Big Dipper about a node ID, for example before a sensitive transaction. The request is signed by the contact's node, so the requester is identified by node ID.
4. **Big Dipper sends the permission request to the owner**, who sees it in their own Little Dipper app: who is asking, what they want to know and why.
5. **The owner approves or declines.**
6. **If approved,** the current values of the verified claims are checked against the result's hashes, and Big Dipper tells the contact: *"Identity verification passed, and the current profile matches"* (per claim, see below). If declined, the contact learns nothing about the result.

## Agreed principles

- **Big Dipper routes every sharing request to the owner for permission.** Results are never shared without the owner's explicit approval of that specific request.
- **Consent happens in the owner's own Little Dipper app,** not by email or on Big Dipper's site. Each approval is per request, can expire and is recorded in the node's audit log.
- **Big Dipper never stores ID documents.** Once checked, documents are deleted. Big Dipper keeps only the **result** and **salted hashes** of the verified values.
- **"Unchanged since verification" is checked by comparing hashes,** so Big Dipper doesn't need to see or store the data again.

## Proposed details (to confirm when building)

These came out of the design discussion and haven't been explicitly confirmed:

- **Per-claim results.** Each claim (legal name, date of birth, citizenship…) has its own status, date, method, assurance level and expiry. If the address changes, the verified name isn't affected. A contact can ask only about the claims a transaction needs (selective disclosure).
- **Per-claim salted hashes**, so one claim can be checked without revealing the others.
- **Signed by Big Dipper**, so anyone holding Big Dipper's public key can check a result's authenticity.
- **Key changes:** decide whether a result carries over when the node rotates its key (the node keeps `keyHistory` with successor signatures) or requires verifying again.
- **Compromise and revocation:** a stolen node key would inherit results, so Big Dipper needs a fast way to revoke them and to publish their status.

## Still open

- **Who delivers the result to the contact: Big Dipper or the owner's node?** With Big Dipper as the lookup service, Big Dipper learns who checks up on whom, which is a social graph. The alternative: the owner's node holds the signed result and sends it to the contact peer-to-peer after consent, and Big Dipper only answers "has this been revoked?". A middle option: Big Dipper keeps results and handles consent, but logs only what it must.
- **Standards:** check W3C Verifiable Credentials and SD-JWT (selective disclosure) before designing a custom format.
- **Assurance levels:** which levels exist and what each requires.
- **Retention:** how long Big Dipper keeps results and request logs.
- **Compliance:** KYC and privacy-law obligations (GDPR, biometric laws) for the verification step itself, even with documents deleted afterwards.

## Impact on Little Dipper (when built)

These are additive changes, per [COMPATIBILITY.md](../COMPATIBILITY.md):

- A new capability advertised in `/.well-known/little-dipper` (Commandment VII), so contacts can tell whether a node supports verification.
- A new kind of incoming request in the owner app: "Theo wants Big Dipper to share your verification result".
- Storage for the signed result, if the owner's node holds it.
- Audit log entries for each approval or decline.
