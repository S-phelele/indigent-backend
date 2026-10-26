# Automated checks (Home Affairs, bank account, deeds)

Three buttons on the verification screen buy an answer from a verification
provider (VerifyNow) and record it as an ordinary external check, marked
**Automated**, so the officer screens, the "what needs attention" list and the
audit trail work exactly as for a check typed in by hand.

| Button | Asks | Outcome |
|---|---|---|
| **Check ID with Home Affairs** | Is this ID number real, does it belong to this name, is the holder recorded as deceased? | PASS = found and name matches. FAIL = no record, or deceased. INCONCLUSIVE = a different name (a maiden name, a typo) — for a person to look at, never an automatic failure. |
| **Check bank account** | Is there an open account, held by this ID number? | PASS = open and held by them. FAIL = no such account, or closed. INCONCLUSIVE = open but held by somebody else (households often bank through a relative). |
| **Check property (deeds)** | What property is registered to this ID number, against what was declared? | PASS = consistent. FAIL = property found although "no other property" was declared. INCONCLUSIVE = a mismatch where the question was left blank, or ownership declared but nothing registered (informal tenure is not on the deeds register). |

Every one is refused unless the applicant consented to external data checks, and
unless a different officer from the one who captured the application is asking.

## What is kept, and what is not

- **Bank account numbers are never stored.** The officer reads the number off the
  uploaded statement, it goes to the provider, and only the last four digits
  appear in the result. Checked by the end-to-end script against the database and
  the audit log.
- Only the outcome, a one-line finding, the provider's reference and the credits
  charged are saved. The provider's full response is not.
- The privacy notice names the provider and the bank check.

## Cost control

- A repeat check on the same application is refused (409) unless the officer
  confirms — it will be charged again.
- `VERIFY_DAILY_CREDIT_LIMIT` caps provider spend over any 24 hours.
- A provider failure saves nothing, so a timeout never leaves a row that looks
  like an answer.

## Try it on your own machine (free, no account)

The default provider is `mock`. Test IDs and accounts are chosen by their last digits:

| | Ends in | Result |
|---|---|---|
| ID number | `0000` | no record |
| | `1111` | holder deceased |
| | `2222` | different name on the register |
| | anything else | found, name matches |
| Bank account | `0000` / `1111` / `2222` | none / closed / held by someone else |
| | anything else | open, held by the applicant |
| Deeds (by ID) | `3333` / `4444` | two properties / one property |
| | anything else | none |

1. `npm run db:deploy` (adds `HOME_AFFAIRS` and `BANK_ACCOUNT` as check sources), then `npm run dev`.
2. Sign in to the admin portal as `verifier@demo.local` / `Demo@2026` (`npm run db:seed` first).
3. Open an application that has consented to data checks and click the buttons.
   The application's own ID number decides the Home Affairs and deeds result, so
   edit it to end in `1111` and so on to see each outcome. For the bank check,
   type an account number ending in `1111`, `2222`, etc.
4. Automated check of all of it against your running API (24 checks):
   `API=http://localhost:5000/api npm run verify:checks` — needs `DATABASE_URL` set, and leaves nothing behind.

## Going live with VerifyNow

**The VerifyNow adapter has never spoken to VerifyNow.** Its API reference could
not be reached when it was written, so these are assumptions taken from their
public pages: that you POST to `/verify` with a `reportType`, that the key is a
Bearer token (or `x-api-key`, via `VERIFYNOW_AUTH_HEADER`), and what the response
fields are called. Everything that might differ is a setting
(`VERIFYNOW_BASE_URL`, `_ID_PATH`, `_BANK_PATH`, `_PROPERTY_PATH`, `*_REPORT_TYPE`,
`_AUTH_HEADER`) or one function (`normaliseVerifyNow*` in `src/lib/verifyProvider.js`).

1. Get **sandbox** credentials and the API reference from VerifyNow.
2. Put the base URL and key in `.env`, set `VERIFY_PROVIDER=verifynow`.
3. Run each button once against the sandbox's test identities. Compare the actual
   JSON with `normaliseVerifyNow*`, and fix field names. Sandbox calls are free.
4. Confirm with them: what a "bank" check returns and whether it matches the ID
   holder; whether the Home Affairs result includes a deceased flag; whether a
   deeds search can be made by ID number and what it costs; the POPIA operator agreement.
5. Set `VERIFY_DAILY_CREDIT_LIMIT`, then switch to production credentials and run
   **one** real application, comparing the credits charged with the invoice.

## Not built

- Capturing bank details at application time (the officer enters them from the statement).
- Looking a property up by erf number or LPI code; it is by owner ID only.
- SARS, UIF, SASSA and credit-bureau checks: still recorded by hand.
