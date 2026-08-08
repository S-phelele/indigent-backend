# Walking the register end to end

How to drive one household from registration to an approved, signed registration,
touching every role on the way. Roughly 20 minutes by hand.

## Before you start

```bash
# backend
cd indigent-backend
npm run demo:seed          # seven accounts, one per role
npm run dev                # http://localhost:5000

# portals, in their own terminals
cd indigent-applicant-portal && npm run dev    # http://localhost:5173
cd indigent-admin-portal     && npm run dev    # http://localhost:5174
```

Every demo account uses the password **`Demo@2026`**.

| Account | Portal | What they do |
|---|---|---|
| `applicant@demo.local` | 5173 | Applies for support |
| `councillor@demo.local` | 5174 | Registers households door to door |
| `capture@demo.local` | 5174 | Captures walk-ins at the front desk |
| `verifier@demo.local` | 5174 | Site visits and external checks |
| `assessor@demo.local` | 5174 | Applies the means test |
| `supervisor@demo.local` | 5174 | Signs the application off |
| `admin@demo.local` | 5174 | Everything, including the final decision |

They are separate people on purpose. The chain refuses to let one person verify
*and* assess *and* sign the same case, so testing with a single account would
pass while proving nothing.

Remove them when you are finished: `npm run demo:remove`.

## Prefer to check it in one command?

```bash
npm run verify:workflow
```

Drives the whole thing over the API and prints 60 checks. Useful as a smoke test
before a demo; the manual walkthrough below is what shows you the screens.

---

## 1. The applicant applies — 5173

Sign in as `applicant@demo.local`, then **Application form**.

The wizard is a questionnaire. Things worth watching:

- **Type the ID number `8503124800081`.** Date of birth, age and sex fill in
  underneath as you type. They are derived, never asked for — one field instead
  of four, and three fewer things to get wrong.
- **Address.** Use *Use my current location* or type an address and verify it.
  Coordinates are optional and the form says so; a household can refuse them and
  still apply.
- **Ownership.** Choose **Owner**. Watch the document checklist grow a *Proof of
  Ownership* row that was not there before — the checklist is conditional.
- **Household.** Add a member or two. Their ages drive the children-under-18 and
  pensioner counts.
- **Income.** Enter `3200` a month across 5 people.
- **The six functioning questions.** Optional, and marked as such. They are health
  information, so they rest on consent rather than on the municipality's statutory
  powers.
- **Consent.** Three separate boxes: the site visit, the data matching, the
  declaration. All three are needed before an officer may visit or run a check.

Upload documents against the checklist rows: **ID copy**, **Affidavit**, **Proof of
ownership**, and *one of* proof of income / proof of grant / bank statements. Any
one of those three satisfies the financial evidence — a household with no bank
account is not shut out.

**Try submitting before uploading.** It refuses, and names exactly what is
missing. Then submit properly: you get a reference like `IND-2026-00012`, and an
SMS appears in the backend console (the console provider — nothing is really sent).

## 2. Verification — 5174 as `verifier@demo.local`

The case is in **My queue**. Open it.

- **Record a site visit.** Outcome *Verified*. Three failed attempts disqualifies,
  and the counter is visible.
- **Record an external check** against SASSA. Outcome *Pass*.
- **Recommend** approval, then **complete the stage**.

It moves to assessment. Try to act on it again as the same officer — you are
refused, by name, because it is no longer your stage.

## 3. Assessment — as `assessor@demo.local`

Open the case from **My queue**.

- **Run the means test.** It takes the higher of what was declared and what the
  checks found, tests the household total *and* the per-person figure against the
  threshold, and shows its working. R3 200 across five people is R640 each, well
  under.
- Confirm the budget, add a note, and **complete the stage**.

## 4. Sign-off — as `supervisor@demo.local`

**Awaiting my signature**. Open the case.

- **Try to approve without signing.** Refused — an unsigned approval is not an
  approval.
- Draw a signature and approve.

The application becomes **Approved**, the chain reads **Complete**, an expiry date
is set twelve months out, and the household gets an SMS and a portal notification.
Check the applicant's dashboard on 5173 — the outcome is there.

## 5. The councillor registers somebody else — as `councillor@demo.local`

This is the door-to-door path, for residents who cannot fill the form in
themselves.

- **Register a household.** Name, cell number, ID. The resident gets an SMS with
  sign-in details — visible in **SMS Outbox** on the admin side, and in the backend
  console. The temporary password is never stored in the log.
- **Capture their application** on their behalf, and submit it.
- **My captures** shows their own work and nothing else. Try to reach
  *Applications* or *Applicants* — the links are not offered, and the API refuses
  even if you type the URL.

## 6. Oversight — as `admin@demo.local`

- **Overview / Analytics** — turnaround percentiles, ageing, demographics,
  ward geography, document bottlenecks, councillor performance, disability
  prevalence.
- **Applications → open the approved one → Print.** The full form, laid out for a
  paper file.
- **Export CSV.** Opens in Excel with readable headers, and ID numbers survive as
  text instead of turning into `8.50312E+12`.
- **Audit Logs.** Every action in the walkthrough, with who and when. This is the
  screen for an AGSA query.
- **Re-verification.** The registration you just approved, with its expiry date.
- **Privacy.** Subject requests, the retention survey, the breach register, and a
  warning that no Information Officer is configured — which is true until you set
  `INFORMATION_OFFICER_NAME` and `INFORMATION_OFFICER_EMAIL`.

## 7. What the applicant can see about themselves — 5173

**Your information**. Everything held about them in plain language: what they
declared, what was derived and *why*, who handled the case, which organisations
their details were checked against, and every change anybody made. Household
members' own ID numbers and income are withheld — those belong to the members.

They can lodge a correction from here. It lands in the admin Privacy queue with a
deadline. Answer it and the applicant sees the response.

---

## Things worth trying to break

| Try this | What should happen |
|---|---|
| Submit with a document missing | Refused, naming what is missing |
| Verify and assess as the same officer | Refused — separation of duties |
| Approve at sign-off without drawing | Refused |
| Sign in as the councillor, open `/applications` | Refused by the API, not just hidden |
| Record a site visit without consent ticked | Refused |
| Delete a row from `AuditLog` in pgAdmin | The database refuses it |
| Refuse a privacy request with no reason | Refused — a refusal needs a lawful ground |

The last one but one is worth doing in pgAdmin, because it is the claim that
matters most: `DELETE FROM "AuditLog";` as the `postgres` superuser is refused by
a trigger. `npm run verify:audit` checks all of that automatically.
