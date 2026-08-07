# Indigent Register — Improvement Plan

Everything below comes from reading the three repositories and exercising them against a
running instance. Items are ordered by what would hurt most if left alone, not by effort.

Legend: **S** ≈ under a day · **M** ≈ 2–4 days · **L** ≈ a week or more

---

> **Status — 7 Aug 2026.**
>
> **Done:** all of Phase 1 · 2.1, 2.3, 2.4, 2.5, 2.6 · 3.1, 3.3, 3.4, 3.5, 3.8 · 4.1, 4.4, 4.5, 4.6 · 5.1
>
> Verified against a running instance: 40 Phase-1 checks, 7 rate-limit checks, 21 Phase-3
> checks, 6 Phase-4 browser checks, a 24-check workflow regression, and 27 unit tests in the
> repo (`npm test`).
>
> **Still open:** 2.2 object storage (needs cloud credentials) · 3.2 resubmission ·
> 3.6 notifications (needs a provider) · 3.7 annual renewal · 4.2 per-step validation ·
> 4.3 label associations · 4.7 error copy · 4.8 reset entry point in the UI ·
> 5.2 bulk actions · 5.3 date filters · 5.4 audit retention.
>
> 3.2, 3.6 and 3.7 remain requirements decisions rather than technical ones.

## Phase 1 — Close before real applicant data goes in ✅

This system will hold ID numbers, bank statements and income declarations for poor
households. Everything in this phase is reachable by someone outside the organisation.

### 1.1 Rate limiting — **S**
There is none. Three routes matter:

| Route | Exposure |
|---|---|
| `POST /api/auth/verify-otp` | 6-digit code, unlimited attempts → exhaustible in minutes |
| `POST /api/auth/send-otp` | unauthenticated → SMS bombing and a direct cost once a gateway is wired |
| `POST /api/auth/login` | credential stuffing, no lockout |

Add `express-rate-limit`: strict per-IP-plus-cell limits on the OTP routes, a slower limit on
login, and a generous global default. Pair with a per-OTP attempt counter so a code dies after
five wrong guesses rather than only on expiry.

### 1.2 Hash OTP codes — **S**
`Otp.code` is stored in plain text ([schema.prisma](../prisma/schema.prisma)). Anyone with read
access to the table can authenticate as any cell number. Hash on write, compare on verify —
the same treatment passwords already get.

### 1.3 Upload MIME handling — **S**
`multer` takes `mimeType` from the client's `Content-Type` header
([documents.js:88](../src/routes/documents.js#L88)) and the download route echoes it back with
`Content-Disposition: inline` ([documents.js:156-164](../src/routes/documents.js#L156-L164)).
A file named `x.pdf` declaring `text/html` will render as HTML on the API's origin.

Fix all three layers: sniff the type from magic bytes server-side, reject anything not on the
allowlist, and serve `attachment` with `application/octet-stream` unless the sniffed type is a
known-safe image or PDF. Note the admin portal currently escapes this by only rendering
`image/*` and `application/pdf` in its blob viewer — that is luck, not defence.

### 1.4 CORS allowlist — **S**
`cors({ origin: true, credentials: true })` ([index.js:21](../src/index.js#L21)) reflects any
origin that asks. Replace with an explicit list from an env var.

### 1.5 Real JWT secret + helmet — **S**
`JWT_SECRET` is still the literal `"some-long-random-string"`. Generate a real one and keep it
out of source. Add `helmet` for the standard header set.

### 1.6 Stop leaking internals — **S**
Three handlers return `details: error.message` to the client
([applications.js:98](../src/routes/applications.js#L98) and two others). Log server-side, return
a generic message.

### 1.7 Password reset — **M**
There is none. Today a forgotten password needs a DBA. The OTP infrastructure already exists —
reuse it for a cell-number-verified reset.

---

## Phase 2 — Before this runs in production

### 2.1 Migrations instead of `db push` — **S**
There is no `prisma/migrations` directory, so schema changes have no history and no rollback.
Generate a baseline now, while the cost is zero, and switch to `prisma migrate`.

> On this machine `npx prisma …` hangs. Run `node node_modules/prisma/build/index.js …`
> instead, and stop the backend first — Windows locks `query_engine-windows.dll.node`.

### 2.2 Move uploads off local disk — **M**
Files go to `./uploads`, so they do not survive a container restart and cannot be shared across
instances. `filePath` is also stored with Windows backslashes, which breaks the moment this
deploys to Linux. Store a POSIX-relative key and put the bytes in S3 or Azure Blob.

### 2.3 Finish the shared Prisma client — **S**
`src/lib/prisma.js` exists and `admin.js` uses it. `auth.js`, `applications.js` and
`documents.js` still call `new PrismaClient()`, so there are four pools where there should be
one. Mechanical change, low risk.

### 2.4 Tests — **M**
There are none in the repo. Priority order: the income calculation, the submit gate, the
role guards, and the audit-log writes. These are the paths where a silent regression changes
who receives support.

### 2.5 Health check that checks something — **S**
`/api/health` returns 200 with Postgres face-down. Add a `SELECT 1` so a load balancer can tell
the difference.

### 2.6 Operational basics — **S**
Structured logging with request IDs instead of bare `console.error`; `prisma.$disconnect()` on
SIGTERM; a `.env.example` (the README references one that was never committed).

---

## Phase 3 — Correctness and domain gaps

### 3.1 Nothing enforces the income threshold — **M**
This is the one to escalate. `incomeBelowThreshold` is a self-declared boolean,
`totalHouseholdIncome` is computed from the five components, and **nothing compares them**. An
applicant can declare "yes, R4 200 or less" alongside R8 000 of income and it reaches the admin
queue looking clean.

At minimum, flag the contradiction on the application and in the admin detail view. Better,
make the threshold a configurable value the municipality can change without a redeploy — the
R4 200 and R7 500 figures currently live in a code comment and in landing-page copy.

### 3.2 No resubmission path — **M**
A declined applicant cannot correct and resubmit. Combined with the one-draft rule, their only
route is to start over. Most declines will be for fixable reasons — an illegible bank statement,
a missing affidavit — so this is the gap most likely to produce walk-in complaints.

### 3.3 Per-document rejection is modelled but unreachable — **S**
`Document.status` allows `'Rejected'` but no endpoint ever sets it, so an admin who finds one bad
document must decline the whole application. Add the endpoint and a control in the admin
document list.

### 3.4 State guards on decisions — **S**
`PATCH /admin/applications/:id/status` does not check the current status, so a DRAFT can be
approved directly. `DELETE /api/documents/:id` is not blocked on submitted applications, so an
applicant can strip evidence off a PENDING one.

### 3.5 SA ID number validation — **S**
Accepted as free text. SA ID numbers carry a Luhn check digit and an embedded date of birth —
both verifiable for free, and worth doing on a register where duplicate or fraudulent identities
matter.

### 3.6 Notifications — **M**
Status changes are silent. An applicant has no way to learn the outcome without signing in and
checking. Email is the cheap first step; SMS matters more for this audience.

### 3.7 Annual renewal — **L**
Indigent status is normally reviewed yearly. There is no expiry, no renewal cycle and no concept
of a lapsed record, so the register only ever grows.

### 3.8 Human-readable reference numbers — **S**
`displayId` is the first eight characters of a UUID. Nobody can read that over a phone. Municipal
systems want `IND-2026-00042`.

---

## Phase 4 — Applicant portal

The portal is well built and matches the API closely. These are the rough edges.

### 4.1 Visiting `/apply` silently consumes the draft slot — **S**
[Apply.jsx:170](../../indigent-applicant-portal/src/pages/Apply.jsx#L170) POSTs a new application
on mount when none exists. Someone who lands on the page and leaves has used up their one
allowed draft, and the database fills with empty rows. Create the draft on first save instead.

### 4.2 No client-side validation between steps — **S**
Every step advances regardless of what was entered; the applicant only discovers required fields
are missing at submit, four steps later. Validate per step, and mark required fields.

### 4.3 Labels are not associated with inputs — **S**
The wizard uses bare `<label>` without `htmlFor`/`id`. Screen readers cannot associate them, and
clicking a label does not focus its field. Mechanical to fix and it matters — this is a public
service form.

### 4.4 Step 3 hides the number that decides the outcome — **S**
The income step shows `totalIncomePerPerson` but not `totalHouseholdIncome`, which is the figure
the threshold is assessed against. Show both, and show how close they are to the threshold.

### 4.5 No way to remove a wrongly uploaded document — **S**
The UI offers "Replace" only. The backend already supports `DELETE /api/documents/:id`, which
resets the row to `Pending`. Wire it up.

### 4.6 The FAQ accordion does not open — **S**
Five questions on the landing page with chevrons that expand nothing. Either wire it up or
remove the affordance.

### 4.7 Raw server messages reach the applicant — **S**
Errors surface `err.response.data.message` directly, so an applicant can see text like
`"Multipart: Boundary not found"`. Map known cases to plain language and use a generic fallback.

### 4.8 No password reset entry point — **S**
Follows 1.7. There is currently no link to start recovery.

---

## Phase 5 — Admin portal

### 5.1 Column sorting is not wired — **S**
`GET /admin/applications` accepts `sortBy` and `sortOrder` and the columns are whitelisted
server-side, but the table headers are not clickable.

### 5.2 No bulk actions — **M**
Approving twenty applications means twenty page loads. Multi-select with a bulk decision, and a
single audit entry per application, would change the daily experience.

### 5.3 Date-range and income-band filters — **S**
Search covers name, ID, cell and email. Reporting questions usually start with a date range.

### 5.4 Audit log retention — **S**
`AuditLog` grows without bound and has no archival policy. Decide a retention period now.

---

## Suggested order

1. **Phase 1 entirely.** Roughly two days, and it closes everything an outsider can reach.
2. **2.1, 2.3, 2.5** — migrations, the shared client, the health check. Cheap now, expensive later.
3. **3.1** — the income threshold gap, because the register can currently approve households that
   do not qualify and nothing in the system catches it. This is what surfaces in an audit.
4. **4.1–4.4** — the applicant portal edges, which affect every person who uses the service.
5. Everything else as capacity allows.

Phases 3.2, 3.6 and 3.7 are requirements decisions rather than technical ones. Worth settling
with whoever owns the policy before more is built on the current model.
