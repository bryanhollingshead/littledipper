# Financial Accounts and Transactions

> **Status: not started.** The `financial_accounts` domain exists. Transaction history is wanted but not designed. See [open question 10](../OPEN-QUESTIONS.md).

## What the account list is for

The `financial_accounts` domain is a **map of the owner's financial life**, not a ledger: kind, institution, nickname, last four digits, balance and joint holder. It never stores full account numbers. It's useful even with no data feed:

- **Estate and emergencies.** When someone dies or can't act for themselves, the hardest job for their family or executor is finding out which accounts exist. Together with the `legal` domain (will, beneficiaries, powers of attorney), it answers "where is everything?" It could be granted to an executor, perhaps later through a grant that opens only after a delay.
- **Giving a professional a view.** An accountant or adviser gets a scoped grant to the list, instead of an emailed spreadsheet.
- **Taxes.** It shows which institutions should send a 1099, so a missing form is easy to spot.
- **Receipts.** A receipt can point to the account that paid for it, for warranties and returns. See [RECEIPTS.md](RECEIPTS.md).

**Weak spot: balance.** Typed in by hand, it's out of date within a week. Until a connector fills it, it should carry an "as of" date and be marked as manual.

## Transaction history (wanted, not designed)

The owner wants transaction history in Little Dipper eventually. It's the most sensitive data a person has, and also among the most useful: matching receipts, taxes, budgeting, and AI contacts that help with money.

### Proposed shape

- **Accounts stay a small, hand-kept list** that everything else links to.
- **Transactions are their own collection, not a domain.** They arrive by the thousands and are mostly written by machines. They need date-range queries, de-duplication across imports, and grants such as "account X, 2025 only". The date-range grant is the same problem as receipts ([question 9](../OPEN-QUESTIONS.md)), and both should share one answer.
- **Balance comes from a sync** when a connector exists.
- **Connectors use the owner's own credentials.** The node talks to the bank side directly. Big Dipper never sees bank data, in keeping with its principle of storing results, not personal data.

### How data gets in: vendor options

In the order suggested:

| Option | What it is | Fit for Little Dipper |
|---|---|---|
| **File import: CSV, OFX, QFX** | Downloads every bank already offers. | **Start here.** No third party, no sign-up, no cost. It can be built any time and fits the table-entry and documents work. Manual, but always available. |
| **[SimpleFIN Bridge](https://beta-bridge.simplefin.org/)** | An aggregator built for personal use. The owner pays about $15 a year and pastes a token into their own node. | **Best first automatic connector** for US and Canadian banks. Actual Budget, a self-hosted budgeting app, uses it for exactly this reason. Read-only. |
| **GoCardless Bank Account Data** (formerly Nordigen) | PSD2 open banking aggregator for the UK and EU. | The European counterpart to SimpleFIN, and also used by Actual Budget. Check its current terms for personal and self-hosted use before relying on it. |
| **US open banking (CFPB Section 1033 rule, FDX APIs)** | A regulation meant to let people send their bank data directly to a tool they choose. | Ideal in principle: no aggregator in the middle. The rule has been under reconsideration, so **don't plan around it** until it settles. Revisit periodically. |
| **Plaid, MX, Finicity, Yodlee** | Commercial aggregators sold to companies. | **Poor fit.** Access goes to approved companies, not individuals, so every node would need its own approved account. The alternative, one Big Dipper account for everyone, would put everyone's bank data through Big Dipper. Use only if a hosted offering later needs it, and only with the owner's explicit consent. |

### Still open

- When to build it, relative to documents and receipts.
- The transaction data model: fields, categories, pending vs. posted, transfers between the owner's own accounts.
- De-duplication when the same transactions arrive from both a file import and a connector.
- Grant shape: date ranges, per account, or summaries only (for example, "totals by category" without individual transactions).
- Where connector tokens are kept: encrypted with the node key, like other secrets.
- Whether full account numbers are ever needed (today: never; last four only).
