# Automated checks (Home Affairs, bank account, deeds)

Three buttons on the verification screen buy an answer from VerifyNow and record
it as an ordinary external check, marked **Automated**, so the officer screens,
the "what needs attention" list and the audit trail work exactly as for a check
typed in by hand.

Built against VerifyNow's published API reference
(<https://www.verifynow.co.za/api-docs>, "last updated 3 Nov 2026").

| Button | VerifyNow call | Credits (R2.99 each) | Outcome here |
|---|---|---|---|
| **Check ID with Home Affairs** | `POST /verify`, `home_affairs_real_time_idv` | 3 (R8.97) | PASS = found, surname and first name match. FAIL = no record, or recorded as deceased. INCONCLUSIVE = a different name (maiden name, typo) or the register's ID number does not match the one sent. |
| **Check bank account** | `POST /bank-account-verification` | 6 (R17.94), **not charged when unsuccessful** | PASS = open and held by this ID number. FAIL = no such account, or closed. INCONCLUSIVE = open but held by someone else (households often bank through a relative). |
| **Check property (deeds)** | `POST /property-search` | 10 (R29.90), **charged even when nothing is found** | PASS = consistent with what was declared. FAIL = property found although "no other property" was declared. INCONCLUSIVE = a mismatch where the question was blank, or ownership declared but nothing registered (informal tenure is not on the deeds register). |

**A full set is 19 credits, about R57 per applicant** at the standard rate, before any
volume discount. Run the checks only after submission and consent, on applications
that reach verification, not at registration.

Every check is refused unless the applicant consented to external data checks, and
unless a different officer from the one who captured the application is asking.

## Things the reference says that shaped the design

- **The cheaper ID check cannot find the dead.** `said_verification` (1 credit)
  "does not return alive/deceased status". The default is the 3-credit real-time
  report, which does. Switch with `VERIFYNOW_ID_REPORT_TYPE=said_verification` if
  you accept losing that check. An unknown deceased status is treated as unknown, never as "alive".
- **"No record" is an HTTP 502.** For ID checks VerifyNow reports a completed
  negative as 502 with code `NO_RECORD_FOUND` (billed). That is a real answer and
  becomes a FAIL; it is not confused with 502 `VERIFICATION_TEMPORARILY_UNAVAILABLE`,
  which is a fault, retryable, and records nothing.
- **A bank check-digit error is not a verdict.** Response code 6 means the account
  number fails the bank's own validity test, usually a typo. The officer is told to
  re-check the number; nothing is recorded and nothing is charged.
- **Production needs an `Idempotency-Key`.** The same key with the same request
  replays the saved answer without a second charge. Keys here are a hash, so no ID
  number travels in a header.
- **Sandbox is on by default.** Every request carries `mode`. It is "sandbox" (free,
  mock data) unless `VERIFYNOW_MODE=production` is set exactly. Sandbox and mock
  results are labelled **[Test data]** on screen and the provider is stored as
  `verifynow-sandbox`, so they can never be read as a finding about a real household.
- **Postbank is not supported.** Many grant recipients are paid into Postbank
  accounts, which VerifyNow's bank list does not include. Record those by hand.

## What is kept, and what is not

- **Bank account numbers are never stored.** The officer reads the number off the
  uploaded statement, it goes to VerifyNow, and only the last four digits appear in
  the result. Checked by the end-to-end script against the database and the audit log.
- The property response also carries the buyer's name, price and bond details;
  only a one-line description of each property (title deed, address, type) is kept.
- Only the outcome, a one-line finding, the VerifyNow reference and the credits are saved.
- The privacy notice names the provider and the bank check.

## Cost control

- A repeat check on the same application is refused (409) unless the officer
  confirms: it will be charged again.
- `VERIFY_DAILY_CREDIT_LIMIT` caps spend over any 24 hours.
- A provider failure saves nothing, so a timeout never leaves a row that looks like an answer.

## Try it on your own machine (free)

**1. Built-in mock (no network).** The default provider. Test inputs by last digits:

| | Ends in | Result |
|---|---|---|
| ID number | `0000` / `1111` / `2222` | no record / deceased / different name |
| Bank account | `0000` / `1111` / `2222` | none / closed / held by someone else |
| Deeds (by ID) | `3333` / `4444` | two properties / one property |

**2. The real adapter against a local stand-in for VerifyNow (still free).**
`node scripts/fake-verifynow.js` speaks VerifyNow's documented protocol (`x-api-key`,
`mode`, idempotency keys, the real error shapes). Then run the API with
`VERIFY_PROVIDER=verifynow VERIFYNOW_API_KEY=anything VERIFYNOW_BASE_URL=http://127.0.0.1:4010/api/external`.
Set `FAKE_NAMES="GRACE|MTHEMBU"` to the applicant's name so a Home Affairs check passes.

Either way:
1. `npm run db:deploy`, `npm run db:seed`, `npm run dev`.
2. Sign in to the admin portal as `verifier@demo.local` / `Demo@2026`.
3. Open an application that has consented to data checks and click the buttons.
   The application's own ID number decides the Home Affairs and deeds result, so edit
   it to end in `1111` and so on. For the bank check, choose a bank and type an
   account number ending in `1111`, `2222`, etc.
4. `API=http://localhost:5000/api npm run verify:checks` runs 29 checks against your
   running API (needs `DATABASE_URL`; leaves nothing behind).

## Going live

1. In your VerifyNow dashboard, create an API key and buy a small block of credits.
2. Set `VERIFY_PROVIDER=verifynow` and `VERIFYNOW_API_KEY`. Leave `VERIFYNOW_MODE`
   unset: you are in sandbox. The server logs a warning saying so.
3. Run each button against VerifyNow's **sandbox**. Their reserved test inputs: an ID
   ending `90` returns a completed negative, `91` a simulated error; a bank account or
   ID ending `90`/`91` likewise. Sandbox calls cost nothing but have a 2-second cooldown
   per identical request.
4. Compare their real sandbox JSON with the examples in `tests/verifynow.test.js`
   (taken from their reference). If a field name differs, fix `normaliseVerifyNow*`.
   An unreadable response is raised as an error, never guessed.
5. Ask VerifyNow: does `home_affairs_real_time_idv` return `deceasedStatus` as
   "Alive" or "No" for living people? Is there a government or volume rate? What is
   the retention of results and sub-processor list (their reference says to confirm
   these in the contract/DPA)? Is a POPIA operator agreement available?
6. Set `VERIFY_DAILY_CREDIT_LIMIT`, then `VERIFYNOW_MODE=production`, and run **one**
   real application, comparing the credits charged with the invoice.

## Procurement

A municipality usually cannot just buy a service: MFMA supply-chain rules
(quotations or a tender) probably apply. Settle that before production credits.

## Not built

- Capturing bank details at application time (the officer enters them from the statement).
- Looking a property up by erf number or LPI code; it is by owner ID only.
- Showing the VerifyNow credit balance (`GET /my_credits` exists).
- SARS, UIF, SASSA and credit-bureau checks: still recorded by hand.
