# Verify the number at registration, and carry it through

Design agreed 13 August 2026. Not yet implemented.

## The problem

Three separate faults, all in the same seam between an account and the application
it holds.

**The OTP is in the wrong place and proves nothing.** It sits at step 2 of the
application wizard and is explicitly skippable — a deliberate choice, made so a
household on a borrowed phone or with no signal at the gate could still apply.
The intent was right. The effect is that an application can reach an approval
queue with a number nobody has ever confirmed, and the municipality then has no
way to reach the person it is deciding about.

**`Application.cellVerified` can be forged.** It is a plain boolean accepted from
the request body in `PATCH /api/applications/:id`. Any client can send
`cellVerified: true` without a code ever being issued. The badge in the admin
portal reads from it, so the screen an officer trusts is showing a value the
applicant supplied about themselves.

**The ID number is captured twice and can diverge.** `User.idNumber` is optional
at registration; `Application.idNumber` is separate and independently editable.
Nothing reconciles them, so the register can hold two different ID numbers for
one person with no indication which is right.

## Decisions

| Question | Decision |
|---|---|
| How hard is the gate? | Account is created and signed in, but starting **or** submitting an application is refused until the number is verified |
| ID number at registration | Required and validated; the application field stays editable, and a divergence is flagged to the reviewer |
| ID strictness | Unchanged — `SA_ID_STRICT` stays false. The Luhn rule would reject real people the municipality already holds |
| Existing unverified accounts | Same gate, no grandfathering. Already-submitted applications are untouched |
| The wizard's verify step | Removed. Five steps, and particulars shows the number read-only with a Verified badge |
| How the verified fact is stored | Live on the user, **frozen onto the application at submission** |
| N/A defaults | Derived on read, never written to the database |

## Why the fact is frozen rather than derived

The tempting design is to keep one truth on the `User` and compute the
application's verified status from it on every read. It is simpler and it is
wrong, for the same reason `incomeThresholdApplied` is frozen at submission
today: an applicant who changes their cell number in 2027 would retroactively
turn an application decided in 2026 into one that reads "not verified". An
auditor asking whether the number was confirmed at the moment public money was
approved would get an answer about today instead.

So the account holds the live truth, and `submit()` copies it onto the record.
A draft reports the account; a submitted application reports its snapshot.

## Schema

Three columns, one migration.

```prisma
model User {
  /// When this account's number was proved. isVerified says whether; this says when.
  cellVerifiedAt      DateTime?
}

model Application {
  /// Frozen from the account at submission. See submission.js.
  cellVerifiedAt      DateTime?
  /// The number as it was verified, kept so a later change cannot rewrite history.
  cellVerifiedNumber  String?
}
```

`Application.cellVerified` stays, but becomes server-written only.

`User.idNumber` remains nullable in the schema. Self-registration requires it;
councillor and staff-created accounts legitimately have none at creation
(`fieldwork.js`, `staff.js`), and making the column non-null would break that
path for no gain.

## The gate

A `requireCellVerified` middleware, modelled on `requirePasswordChanged` and
mounted the same way in `index.js` — globally, so no route can be missed. That
pattern already exists for exactly this shape of problem and should not be
reinvented.

- Applies only where `role === 'APPLICANT'`. Staff are verified by whoever
  created their account; gating a verification officer on an SMS would be absurd.
- Refuses with `403` and `code: 'CELL_VERIFICATION_REQUIRED'`, which the portals
  use to redirect, exactly as they do for `PASSWORD_CHANGE_REQUIRED`.
- Lets through: `GET /api/auth/me`, `PATCH /api/auth/me`, `POST /api/auth/send-otp`,
  `POST /api/auth/verify-otp`, `POST /api/auth/change-password`, `POST /api/auth/logout`.

`PATCH /me` is on that list deliberately. Somebody who mistyped their number must
be able to correct it without being stranded behind a code that can never arrive.

## Registration

`POST /api/auth/register` changes shape:

1. `cellNumber` and `idNumber` become required, validated before anything is
   written. ID goes through `saId.validate` in its current lenient mode.
2. Uniqueness widens to include `cellNumber`. Two accounts on one number make the
   OTP ambiguous — there would be no way to say which account a code verified.
3. The account is created and a token issued, as today.
4. The server issues and sends an OTP immediately, so the applicant lands on the
   verify screen with the SMS already on its way. `demoOtp` is returned in
   development exactly as `send-otp` does it.
5. The `WELCOME` SMS moves to **after** verification succeeds. Two messages
   arriving together, one containing a code, is how people mistake the welcome
   for the code and type the wrong thing.

`POST /api/auth/verify-otp` stops hand-parsing the `Authorization` header. It
sets `isVerified`, `cellVerifiedAt` and `cellNumber` together and writes an audit
record.

## Carrying it through

In `submission.submit()`, alongside the existing threshold freeze:

```js
cellVerified:       user.isVerified,
cellVerifiedAt:     user.cellVerifiedAt,
cellVerifiedNumber: user.cellNumber,
```

Read from the account inside `submit()` so both doors — resident self-submit and
councillor field capture — produce the same record. That is what the module
exists to guarantee.

`readiness()` gains one problem for an unverified number, listed alongside the
missing documents rather than on a separate error path.

On read, every application response carries a `verification` object:

```
{ verified, verifiedAt, number, source: 'account' | 'submitted' }
```

Built in one shared helper so admin, approver, applicant and mobile read the same
shape — the same reason `describeTrail` was unified.

Shown on: the admin detail (the existing badge starts telling the truth and gains
its date), the verification queue, the approver view, and the applicant's own
detail screen.

## Applicability: N/A versus Not provided

`src/lib/applicability.js`. Returns, per field, a real value, `'N/A'`, or
`'Not provided'`. Derived on read and attached to application responses so all
three clients agree rather than each inventing its own rule.

Never written to the database. A literal `"N/A"` in a column would have to be
taught to meter-number validation, income arithmetic, ID uniqueness and every
CSV export, and afterwards a real value could never be told from a filled-in
default.

| Field | N/A when |
|---|---|
| `employerName`, `employerAddress`, `workTelNumber` | `employmentStatus` is not employed |
| `otherPropertyDetails` | `ownsOtherProperty === false` |
| `eskomAccountNumber` | electricity is municipally billed |
| `oldAgePension` | `pensionersOver60 === 0` |
| Household member `monthlyIncome` | member is under 18 |
| The six functioning questions | all six unanswered — the set was never asked |

### The income block needs a wizard change, not a display rule

`salary`, `businessIncome` and `rentingIncome` are `Decimal?`, and today a blank
is `null` whether the household earns nothing or was never asked. There is no
governing answer to infer from, so no display rule can fix it.

The wizard writes `0` when somebody declares no income of that type, reserving
`null` for unanswered. After that "R 0.00" and "Not provided" read differently
on their own and the income block needs no N/A rule at all.

## Clients

**Mobile.** The wizard drops to five steps: `apply/verify.tsx` is deleted and its
route removed; `WIZARD_STEPS`, `StepKey` and `completedSteps` shrink accordingly.
`particulars.tsx` shows the number read-only with a Verified badge. A new
post-registration verify screen takes over the OTP UI wholesale — the six-box
autofill input in the existing screen is good and must be moved, not rewritten.
`api.ts` catches `CELL_VERIFICATION_REQUIRED` and routes to it, exactly as it
handles `PASSWORD_CHANGE_REQUIRED`.

**Applicant portal.** `OtpModal.jsx` moves out of `Apply.jsx` into registration.
`Apply.jsx` loses its `cellVerified` local state and its two OTP calls.

**Admin portal.** The verified badge gains its date. N/A rendering replaces the
bare `—` wherever the derived map says not-applicable.

## Testing

Existing suites stay green — 387 tests at the time of writing.

New:

- `applicability.test.js` — each rule, and the not-asked versus answered distinction.
- Registration: cell and ID required; duplicate cell refused; OTP issued on register;
  welcome SMS not sent before verification.
- The gate: an unverified applicant is refused draft creation and submission, while
  `send-otp`, `verify-otp` and `PATCH /me` still pass; staff are unaffected.
- Submission: the snapshot is written from the account and ignores the request body.
- A changed cell number after submission leaves the submitted application reading
  verified, with its original date and number.

## What this deliberately does not do

It does not make the ID check digit strict, and it does not remove the ability to
apply on somebody else's behalf. The councillor path stays exactly as it is: a
resident who cannot use a phone at all is registered at their door by somebody
who can, and that account is verified by the officer who created it rather than
by SMS.
