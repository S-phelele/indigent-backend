# What each thing must prove

A manual test pass over the register. `WALKTHROUGH.md` is the screen-by-screen
tour; this is the list of claims and how to confirm each one.

Two halves, and they are not the same kind of thing:

- **Part A is verifiable today.** Every expectation is something the code on
  `main` should already do.
- **Part B is not built yet.** It is the acceptance criteria for the designs in
  `docs/superpowers/specs/2026-08-13-*`. Nothing in it will pass now, and that is
  correct.

## Setup

```bash
npm install
npm run db:setup          # schema + append-only triggers, checked step by step
npm run demo:seed         # seven accounts, one per role
npm run dev               # http://localhost:5000

cd ../indigent-applicant-portal && npm run dev    # :5173
cd ../indigent-admin-portal     && npm run dev    # :5174
```

Password for every demo account: `Demo@2026`. Seven accounts because separation of
duties means one person cannot verify *and* assess *and* sign the same case —
testing with a single admin would pass every screen and prove nothing.

## Machine checks first

| Command | Expect |
|---|---|
| `npm test` | 387 tests, 0 failures, ~38s. No database or server needed. |
| `npm run verify:workflow` | 13 stages over the live API, `ok`/`FAIL` tally. Needs `dev` + `demo:seed`. Leaves one approved application behind on purpose. |
| `npm run verify:audit` | Append-only triggers survived the migration squash. |

If any fail, stop. The manual pass will only say the same thing more slowly.

`verify:audit` previously tested row-level triggers against a possibly empty
table and reported the audit trail as unprotected on a fresh database. That was
fixed in `720ac38`; a pass on an empty database is the fix working.

---

# Part A — verifiable today

## 1. The applicant applies (`05f4302`, `e4ba5e9`)

At :5173 as `applicant@demo.local`.

| Do | Must happen |
|---|---|
| Type ID `8503124800081` | Date of birth, age and sex fill in underneath as you type. Derived, never asked. Sex correctable. |
| Answer "employed?" with no | Employer questions come *after* the employment question, and the server clears employer details. Re-open and confirm they stayed empty. |
| Choose tenure: Owner | A *Proof of Ownership* row appears that was not there before. |
| Look at the checklist order | Everything that blocks submission sits above everything optional. |
| Postal address → same as residential | No copy stored. Change the residential address; the postal one follows. |
| Income 3200 across 5 people | Household total and per-person figure both compute. R640 each. |
| **Submit with a document missing** | **Refused, naming exactly what is missing.** Not a generic "incomplete". |
| Upload ID copy, affidavit, ownership, *one of* three financial options | Any one satisfies financial evidence — no bank account is not a bar. |
| Submit properly | Reference like `IND-2026-00012`, SMS in the backend console and the admin SMS Outbox. |

## 2. Verification and separation of duties (`056d262`, `d9b8640`)

At :5174 as `verifier@demo.local`.

| Do | Must happen |
|---|---|
| Site visit, outcome Verified | Attempt number allocated by the server, not sent by the client. Failed-attempt counter visible. |
| **Untick site-visit consent, record a visit** | **403 `NO_CONSENT`.** |
| **POST `{"outcome": "MAYBE"}`** | **400 naming the accepted values** — not a 500 telling the officer to try again. Trying again could never work. |
| External check, SASSA, Pass | Recorded. Recommend approval, complete the stage. |
| **Act on it again as the same officer** | **Refused by name** — no longer your stage. The most important refusal in the system. |

## 3. Assessment and sign-off (`28d6bc9`)

| Do | Must happen |
|---|---|
| Assessor: run the means test | Takes the *higher* of declared and found, tests household total *and* per-person, shows its working. |
| **Supervisor: approve without drawing** | **Refused.** An unsigned approval is not an approval. |
| Draw and approve | Approved; chain Complete; expiry twelve months out; SMS and portal notification. |

## 4. The approval chain is visible (`fa05768`)

| Do | Must happen |
|---|---|
| Admin → approved application | Every stage, which officer, when, and the reason verbatim. |
| Approver view, same case | Identical vocabulary — both render from one `describeTrail()`. |
| Applicant timeline on :5173 | Three named stages with real dates, **no officer named**. Confirm in the raw API response, not just on screen. |
| Return an application to a prior stage | The holding stage reads *current*, not done. |

## 5. Sign-in security (`33b9f1c`)

| Do | Must happen |
|---|---|
| Fail sign-in three times | Silence at first. Warning only at two attempts remaining. |
| **Keep going** | **429 `ACCOUNT_LOCKED`** with minutes left. Locks escalate and expire on their own. Staff lock notifies an admin. |
| Two devices, change password on one | Other device gets **401 `SESSION_REVOKED` on its next request**. The changing device stays in on a fresh token. |
| `JWT_EXPIRES_IN=7d` in `.env`, restart | Boot warning; session still `SESSION_HOURS` (8). |
| **Reuse a spent reset code** | **Refused.** Single use, 10 minutes. A successful reset also clears a lock. |

## 6. POPIA (`161ccc5`, `720ac38`)

| Do | Must happen |
|---|---|
| Applicant → "Your information" | Everything held, in plain language, including what was derived and why. Household members' own ID numbers and income **withheld**. |
| **Refuse a correction with no reason** | **Refused** — a refusal needs a lawful ground. |
| Retention survey without confirming | Dry run. Declined and lapsed anonymise; approved kept for MFMA audit. |
| **`DELETE FROM "AuditLog";` as `postgres`** | **The database refuses it** — a trigger, not application code. Try `UPDATE` and `TRUNCATE` too. Run this by hand at least once. |

## 7. The door-to-door path (`056d262`)

| Do | Must happen |
|---|---|
| Councillor registers a household | SMS with sign-in details in the outbox. **Temporary password redacted from the log.** |
| Sign in as that resident | **Everything except profile and change-password refused** with `PASSWORD_CHANGE_REQUIRED`. |
| **As councillor, type `/applications`** | **The API refuses it**, not just a hidden link. |

## 8. Oversight and network (`05f4302`, `28ea624`)

| Do | Must happen |
|---|---|
| Export CSV | Readable headers; **ID numbers survive as text**, not `8.50312E+12`. |
| Statistics workbook and printable report | Compare one figure across both — built from one definition, must not disagree. |
| Expo web build from another LAN device | Accepted (RFC 1918). Set `NODE_ENV=production` and retry → **refused**. Allowlist entries need a scheme. |
| Admin → Audit Logs | **Every action in this walkthrough**, with who and when. A missing step is a finding. |

---

# Part B — designed, not built

Fails today by definition. Acceptance criteria for
`2026-08-13-registration-verification-design.md` and
`2026-08-13-progress-indicators-design.md`.

## B1. OTP at registration

| Do | Must happen |
|---|---|
| Register a new applicant | Cell number and ID both required. Account created, signed in, OTP already sent. |
| **Start an application before verifying** | **403 `CELL_VERIFICATION_REQUIRED`.** Draft creation *and* submission refused. `/me`, `send-otp`, `verify-otp`, `PATCH /me`, change-password, logout still pass. |
| **PATCH `cellVerified: true`** | **Silently ignored** — server-written only. Verify in the database, not the response. |
| Existing unverified applicant signs in | Same gate. Already-submitted applications untouched. |
| Any staff account signs in | Unaffected. |
| Verify, then walk to submission | Wizard is **five steps**; particulars shows the number read-only with a Verified badge. |
| Submit, then change the cell number | Submitted application **still reads verified, original date and number**. Account returns to unverified. |

## B2. N/A versus Not provided

| Do | Must happen |
|---|---|
| Unemployed applicant, admin view | Employer fields read **N/A**, not `—`. A genuinely unanswered field reads **Not provided**. |
| Check those columns in the database | **Still NULL.** Derived on read, never written. |
| Declare no salary in the wizard | Stores **0**, renders **R 0.00**. A field never reached stores NULL, renders **Not provided**. |
| Skip the functioning questions | **N/A — not asked**, `hasDisability` stays NULL. |

## B3. Progress

| Do | Must happen |
|---|---|
| Slow 3G, upload 4 MB | **Real percentage** from bytes sent, file name and size, **working cancel**. Completion morphs into a tick. |
| Cancel mid-upload | Clean abort. Slot returns to empty. **No orphan in `uploads/`.** |
| Submit and watch the button | Staged: Checking your documents → Submitting → Sending your reference. |
| Reduce-motion on | Static states, numbers remain, `aria-busy`/`aria-live` still announce. |
| Watch a percentage stall | Stalls **honestly**. A bar creeping to 90% and waiting is a fabricated number and a defect. |

---

## When something fails

Two failures look alike and are not.

An **expected refusal** is the system working — a 403 naming a rule, a 400 naming
the accepted values.

A **500 telling you to try again** is almost always the bug, because trying again
cannot help. That exact pattern is what `d9b8640` fixed for enum outcomes. Treat
any "please try again" on an action that could never succeed as a defect, not a
flake.

If everything fails at step 1, check the boring things: `db:setup` completed all
its steps, `demo:seed` ran, the backend is on :5000, and `.env` has no stale
`JWT_EXPIRES_IN`.
