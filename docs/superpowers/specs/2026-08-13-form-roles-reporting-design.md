# The form, the roles, and reporting

Design agreed 13 August 2026. Not yet implemented.

Third of three specs from this session. See also
`2026-08-13-registration-verification-design.md` and
`2026-08-13-progress-indicators-design.md`.

## Decisions

| Question | Decision |
|---|---|
| Superuser | Full access to everything, including every stage of one case. Separation of duties does not bind it; overrides are recorded |
| Multi-name applicants | Add `fullName`, keep `surname`, derive initials |
| Household roll versus occupant count | Warn while filling in, refuse at submission |
| Income model | A proper `IncomeSource` table, one row per source |

---

# 1. The application form

## 1.1 Names

Add `fullName` to `Application`, holding every given name as written. `surname`
stays its own column because queues, search, CSV export and SMS templates all
sort and match on it, and splitting a full name back into a surname reliably is
not possible.

Initials are derived, never stored: first letter of each whitespace-separated
part of `fullName`, uppercased, full-stopped. `Nomsa Thandiwe` becomes `N.T.`

Existing rows backfill `fullName` from `names`. `names` is retained until the
backfill is confirmed, then removed in a later migration — not in this one, so
the change is reversible.

## 1.2 Sex and date of birth

Sex is already derived from the ID number and left correctable on the resident's
form (`sexFromIdNumber` in `Apply.jsx`, guarded by `sexTouched`). Two gaps:

- **Date of birth is not shown at all.** `Apply.jsx` says so in a comment — it is
  derived server-side into `Application.dateOfBirth` but never surfaced. Add it
  as a read-only field that fills in from the ID as it is typed, beside age.
- **The councillor form does not derive sex.** It renders `DerivedIdentity` but
  has no sex field wired to the ID. Fixed by 1.5 below.

The derivation itself moves behind one shared source. `sexFromIdNumber` currently
exists as a local copy in `Apply.jsx` while `saIdNumber.js` on the server does the
same job; two implementations of a century rule is one too many.

## 1.3 The household roll must match the headcount

`peopleOnProperty` is a number the applicant types; the household roll is a list
they build. Nothing reconciles them today, so an application can declare five
occupants and list two.

- While filling in: a live count — *3 of 5 people added* — and the form stays usable.
- At submission: refused if the roll does not match, added to `readiness()`
  alongside the missing-document problems.
- The same rule binds councillors, so a door-to-door capture cannot under-record
  a household.

## 1.4 Income replaces employment

The section heading becomes **Income**, and the opening question stops assuming a
job. Instead of *are you employed?* it asks **where your income comes from**, and
the follow-up questions are chosen by that answer.

### Schema

```prisma
enum IncomeSourceType {
  SALARY
  SELF_EMPLOYMENT
  BUSINESS
  CHILD_GRANT
  OLD_AGE_PENSION
  DISABILITY_PENSION
  RETIREMENT_FUND
  RENTAL
  OTHER
}

model IncomeSource {
  id             String           @id @default(uuid())
  applicationId  String
  type           IncomeSourceType
  monthlyAmount  Decimal          @db.Decimal(12, 2)

  /// SALARY and SELF_EMPLOYMENT: what the work actually is — "street vendor",
  /// "domestic worker". A job title alone does not tell an assessor much.
  jobDescription String?

  /// BUSINESS only.
  businessName   String?
  businessType   String?
  /// Registered with CIPC, or trading informally. Both are legitimate; only one
  /// leaves a paper trail an external check can find.
  isRegistered   Boolean?

  /// OTHER only: says what it is, because a fixed list would drop the rest.
  otherDetail    String?

  createdAt      DateTime         @default(now())
  application    Application      @relation(fields: [applicationId], references: [id], onDelete: Cascade)

  @@index([applicationId])
}
```

One row per source. A household with an old-age pension, a child grant and a room
let out is three rows — which the five fixed columns could never express, since
two grants or two rentals had nowhere to go.

### The questionnaire

Asked as branches off "where does your income come from", any number selectable:

| Answer | Then ask |
|---|---|
| Employed — salary or wages | What the job is, and how much a month |
| Self-employed | What the work is (vendor, domestic work, piece jobs), and how much |
| A business | Business name, what it does, registered or informal, and monthly income |
| A grant | Which — child grant, old age, disability — and how much for each |
| A pension or retirement fund | Which kind, and how much |
| Rental income | How much |
| Something else | What it is, and how much |
| Nothing at all | No further questions; recorded as no declared income |

### What this replaces

`totalHouseholdIncome` becomes the sum of the rows, computed server-side. The
fixed `salary`, `oldAgePension`, `disabilityPension`, `businessIncome` and
`rentingIncome` columns are retired once the means test, analytics and exports
read from `IncomeSource`. `EmploymentStatus` stays for now — the document
checklist and `ApplicantCategory` still consult it — but is set from the income
answers rather than asked separately.

**This supersedes the income section of the verification spec.** That spec called
for the wizard to write `0` rather than `null` so "earns nothing" could be told
from "never asked". With explicit income sources the distinction is structural:
no row of a type means that type does not apply, and an application with no rows
at all and the "nothing at all" answer is a declaration, not a gap. The `0`-vs-
`null` workaround is dropped.

## 1.5 Councillor capture uses the same questionnaire

`CaptureApplication.jsx` is 460 lines on one page. That was deliberate — the
comment at the top of the file explains it as pacing for somebody standing at a
door. This reverses it: the councillor walks the same numbered steps, in the same
order, with the same wording as the resident's own form.

The reason is consistency of what gets asked. Two forms drift, and the one used
by the person least able to check the result is the one that should ask the most
carefully.

The wizard's step components are extracted so both entry points render the same
questions from one definition rather than the councillor form growing its own
copy. That extraction is the bulk of the work in this item.

---

# 2. Roles and administration

## 2.1 A superuser that does everything

Add `SUPERUSER` to `Role`. It reaches every screen, every stage and every
administrative function, can be assigned to any queue, and **`separationOfDuties()`
does not apply to it**. One super admin can take a case from capture through
verification and assessment to signed approval on their own.

This was decided deliberately and against the recommendation recorded here, which
was to let the superuser act at any stage except a second one on a case it had
already touched. That recommendation was raised, considered and overruled; the
requirement is a role that does everything, and that is what is built.

What separation of duties was protecting: nobody approving public money on their
own signature. With this role that control no longer exists in the code, so the
audit trail becomes the only place it survives. Therefore:

- Every stage a superuser takes on a case it has already worked is recorded with
  `SUPERUSER_OVERRIDE` on the approval step and in the audit trail, naming the
  officer, the stage and the prior stage they had already taken.
- The approval trail renders those steps distinctly, so an administrator or an
  auditor opening the case sees at a glance that one person walked it through.

Nothing is blocked and nothing prompts. The override is recorded, not refused.

Grant the role sparingly. An account with it is, on its own, sufficient to
manufacture an approved indigent registration.

## 2.2 Staff roles come from the enum

`ROLES` in `Staff.jsx` lists three roles. `Role` has seven. **`ASSESSMENT_OFFICER`
and `SUPERVISOR` are missing**, so an administrator cannot appoint anybody to
stages two and three of the approval chain through the interface at all — the
seeded demo accounts are the only way they exist.

Serve the assignable roles from the backend, derived from the enum, with label
and hint alongside. A role added to the schema then appears in the dropdown
without a second edit in a different repository. `APPLICANT` is excluded (see
2.3) and `ADMIN` and `SUPERUSER` are assignable only by a superuser.

## 2.3 Administrators stop creating applicants

Remove `POST /api/admin/applicants` and the interface that calls it. An applicant
account is created by the person it belongs to, or by a councillor at their door
with an SMS they receive — both of which produce a record of who created it and
a password only the holder ends up knowing.

`PATCH /applicants/:id` stays: correcting a captured detail is legitimate, and
the change log already records it. `DELETE` stays as it is, governed by the
retention rules.

## 2.4 Officers are told when work reaches their stage

`notify.js` exports `toUser` and `toAdmins`. There is no way to notify a role, so
when an application is submitted only administrators are told
(`submission.js`), and a verification officer learns about new work by
looking at their queue. Officers are notified individually only when a stage is
assigned to them by name (`approvals.js`).

That is the whole of the reported fault: the notifications are not failing to
appear, they are not being sent.

Add `notify.toRole(role, {...})`, and call it wherever work enters a stage —
submission into verification, and each advance along the chain. Administrators
keep their existing notifications; they are accountable for the register but sit
in no queue.

---

# 3. Reporting

## 3.1 Scope

Whole-municipality or a single ward. There is no municipality model and none is
added: this deployment serves one municipality, and "by municipality" means every
ward together. Multiple municipalities in one instance would be a tenancy change
and is out of scope.

## 3.2 Filters

Combinable, and applied to one shared query so a figure cannot differ between two
screens:

- Ward, or all wards
- Status and approval stage
- Date range, on submission or on decision
- Disability — the Washington Group threshold, with *not asked* kept distinct
  from *no difficulty*
- Income source type, including households with no declared income
- Applicant category, tenure, household size band
- Councillor or capture officer, for performance reporting

## 3.3 Output

The filtered set exports as the multi-sheet Excel workbook and the printable
report that already exist, both built from the single definition introduced in
`05f4302` so the two cannot disagree about a figure. The filters in force are
printed on the report — a statistic without its criteria is not a statistic.

---

# 4. Testing

- Initials derivation, including multi-part names, hyphenated names and one name.
- Household roll versus `peopleOnProperty`: warn while drafting, refuse at submission.
- `IncomeSource` totals feed the means test, including multiple rows of one type.
- A superuser may take every stage of one case, and each stage after the first is
  recorded as `SUPERUSER_OVERRIDE` in the approval step and the audit trail.
- Every other role is still refused a second stage on a case it has worked.
- Assignable roles are served from the enum, and cover every stage of the chain.
- `POST /api/admin/applicants` is gone and refuses.
- `notify.toRole` reaches every active holder of a role and nobody else.
- Report filters compose, and the workbook and printable report agree.
