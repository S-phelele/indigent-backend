# Automated checks (Home Affairs, bank account, deeds)

Three buttons on the verification screen buy an answer from VerifyNow and record
it as an ordinary external check, marked **Automated**, so the officer screens,
the "what needs attention" list and the audit trail work exactly as for a check
typed in by hand.

Built against VerifyNow's published API reference
(<https://www.verifynow.co.za/api-docs>, "last updated 3 Nov 2026").

## What we buy, by name

Prices are VerifyNow's **starter rate, R2.99 a credit, VAT included** (R2.60 before VAT),
from their pricing page and product guide, read on 10 Nov 2026.

| Button | VerifyNow product (dashboard name) | API call | Credits | Price |
|---|---|---|---|---|
| **Check ID with Home Affairs** | **Alive/Deceased Status (Standard)** | `POST /consumer-trace-lite` | 3 | **R8.97** |
| **Check bank account** | **Bank Account Verification** | `POST /bank-account-verification` | 6 (not charged when unsuccessful) | **R17.94** |
| **Check property (deeds)** | **Property Search by ID** | `POST /property-search` | 10 (charged even when nothing is found) | **R29.90** |

**A full set is 19 credits, R56.81 per applicant.** Run only the checks an application
needs: the ID check on everything that reaches verification, the bank check only where a
bank statement was supplied, the deeds check where the applicant owns or declared other
property. That brings the average well under R57.

What each returns and how we read it:

| Check | PASS | FAIL | INCONCLUSIVE |
|---|---|---|---|
| ID | found, surname and first name match | no record, or recorded as deceased | a different name (maiden name, typo), or the record's ID number differs from the one sent |
| Bank | open and held by this ID number | no such account, or closed | open but held by someone else (households bank through relatives) |
| Deeds | consistent with the declaration | property found although "no other property" was declared | a mismatch where the question was blank, or ownership declared but nothing registered |

### Choosing the ID product

VerifyNow sells several ID checks. Only one is needed, chosen with `VERIFYNOW_ID_REPORT_TYPE`:

| `VERIFYNOW_ID_REPORT_TYPE` | Dashboard name | Credits | Price | Gives us |
|---|---|---|---|---|
| `consumer_trace_lite` (default) | Alive/Deceased Status (Standard) | 3 | R8.97 | names, date of birth, **deceased flag** |
| `said_verification` | SA ID Verification | 1 | R2.99 | names, date of birth. **No deceased flag**: a dead person's number passes |
| `home_affairs_real_time_idv` | Alive/Deceased Status (Enhanced) | 10 | R29.90 | real-time from Home Affairs, detailed death fields |

Not needed, and not bought: ID + Photo (10 credits), Marital Status, Consumer/Person Trace,
Address Lookup, Standard KYC Bundle, AML/PEP, CIPC, Face Match, SMS OTP.

**Data minimisation.** The Alive/Deceased (Standard) response also contains the person's
cell number, work phone, email and physical address. We neither need nor keep those: the
parser reads only names, ID number and the deceased flag, and a test proves the rest never
leaves it. VerifyNow still returns them, so this is worth a line in the data processing
agreement. The 1-credit SA ID Verification avoids it but cannot find the dead.

### VerifyNow's pages disagree: settle it with one real call

- The API reference card for the real-time Home Affairs report (`home_affairs_real_time_idv`)
  says **3 credits**; the pricing page, the product guide and the "Home Affairs ID check
  cost" page say **10**. The code assumes 10 for that product, because a spend cap that
  under-counts is worse than one that over-counts.
- The same reference shows Consumer/Person Trace Lite at **5** credits; the pricing page and
  product guide show **3**. The code assumes 3.

`npm run verifynow:smoke` (below) reads the credit balance before and after each check, so
it reports what each product really cost on your account.

## What it costs per month (estimates, starter and volume rates)

Assumes every applicant gets all three checks, which overstates it. Volume discounts apply
automatically on the credits bought in a month: 1,000+ R2.90, 5,000+ R2.84, 10,000+ R2.69.

| Applications a month | Credits (19 each) | Rate | About |
|---|---|---|---|
| 50 | 950 | R2.99 | R2,840 |
| 100 | 1,900 | R2.90 | R5,510 |
| 200 | 3,800 | R2.90 | R11,020 |
| 500 | 9,500 | R2.84 | R26,980 |

## Things the reference says that shaped the design

- **The cheapest ID check cannot find the dead.** `said_verification` (1 credit)
  "does not return alive/deceased status". The default, Alive/Deceased Status
  (Standard), costs 3 credits and does. An unknown deceased status is treated as
  unknown, never as "alive".
- **"No record" is an HTTP 502 on `/verify`.** For the two `/verify` ID reports
  VerifyNow reports a completed negative as 502 with code `NO_RECORD_FOUND` (billed).
  That is a real answer and becomes a FAIL; it is not confused with 502
  `VERIFICATION_TEMPORARILY_UNAVAILABLE`, which is a fault, retryable, and records
  nothing. The trace service's reply for an unknown ID is not documented: an empty
  result is treated as "no answer", never as "no such person".
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
Set `FAKE_NAMES="GRACE|MTHEMBU"` to the applicant's name so an ID check passes. It also serves
`GET /my_credits`, so `npm run verifynow:smoke` runs against it too.

Either way:
1. `npm run db:deploy`, `npm run db:seed`, `npm run dev`.
2. Sign in to the admin portal as `verifier@demo.local` / `Demo@2026`.
3. Open an application that has consented to data checks and click the buttons.
   The application's own ID number decides the Home Affairs and deeds result, so edit
   it to end in `1111` and so on. For the bank check, choose a bank and type an
   account number ending in `1111`, `2222`, etc.
4. `API=http://localhost:5000/api npm run verify:checks` runs 29 checks against your
   running API (needs `DATABASE_URL`; leaves nothing behind). It passes with the mock
   provider and with the stand-in.

## Going live against the real VerifyNow

### 1. Account, key and credits
1. Create an account at <https://www.verifynow.co.za> ("Get started free"). Sign-up is free.
2. In the dashboard, open **API Keys** and generate a key. You accept their API policies
   at that point, and their Data Processing Agreement forms part of the terms.
3. **Buy Credits.** Buy a small block first: 100 credits (about R299) covers five full sets
   of test checks. Credits are non-refundable once bought and do not expire while the account
   is active. Purchases above 10,000 credits go by EFT invoice. Their pages do not state a
   minimum top-up: check the Buy Credits screen.

### 2. Free: prove the wiring in VerifyNow's sandbox
```bash
VERIFYNOW_API_KEY=vn_live_... npm run verifynow:smoke -- --id 8001010000990 --first Thabo --surname Mokoena \
    --bank FNB --account 123456790 --type SAVINGS --property
```
Sandbox uses the same key, spends nothing, and returns mock data. The script prints the
**structure** of each real response (field names and types, never values). If a name differs
from what `src/lib/verifyProvider.js` reads, that is where it shows. VerifyNow's reserved
sandbox inputs: an ID or account ending `90` gives a completed negative, `91` a simulated
error; repeating an identical call within 2 seconds returns 429.

### 3. About R60: one real check on yourself
Use **your own** ID number and a bank account of **your own**, with your own consent.
```bash
VERIFYNOW_API_KEY=vn_live_... npm run verifynow:smoke -- --production --id <your ID> \
    --first <first name> --surname <surname> --bank <bank> --account <number> --type SAVINGS --property
```
It waits five seconds after printing the cost, then reports for each check the balance
before and after, the credits really charged, the outcome, and whether a deceased flag came
back. This is the step that settles the price disagreements above. If a charge differs from
the table, set `VERIFYNOW_CREDITS_*` to the real figure.

### 4. Switch on in the server
```
VERIFY_PROVIDER=verifynow
VERIFYNOW_API_KEY=...            # a secret: put it in the environment, never in git
VERIFYNOW_MODE=production
VERIFY_DAILY_CREDIT_LIMIT=200    # about ten full sets a day; raise it deliberately
```
Leave `VERIFYNOW_ID_REPORT_TYPE` unset for the default (Alive/Deceased Status Standard).
The server logs a warning at start-up for sandbox mode, a missing key, an ID product that
cannot find the dead, or mock in production.

### 5. Ask VerifyNow, in writing
- Does Alive/Deceased Status (Standard) return `Deceased` as "No" for living people?
- What happens on that product when the ID number is not found? (The code treats an empty
  result as "no answer", never as "no such person".)
- Is there a government or volume rate, and what is the minimum top-up?
- Retention and sub-processors, and the POPIA operator agreement (their terms point to a
  Data Processing Agreement).

### Procurement
A municipality usually cannot just buy a service: MFMA supply-chain rules (quotations or a
tender) probably apply. Settle that before production credits.

## Not built

- Capturing bank details at application time (the officer enters them from the statement).
- Looking a property up by erf number or LPI code; it is by owner ID only.
- Showing the VerifyNow credit balance on screen (`balance()` exists; the smoke script uses it).
- SARS, UIF, SASSA and credit-bureau checks: still recorded by hand.
