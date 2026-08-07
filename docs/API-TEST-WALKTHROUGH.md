# Indigent Register — Step-by-Step API Test Walkthrough

A single ordered pass through the whole API, by hand in Postman. Each step says what to
send and what to carry into the next one.

- **Reference** (every endpoint, alphabetical by area): [`API-TESTING.md`](API-TESTING.md)
- **Automated version**: [`postman/INDIGENT.postman_collection.json`](../postman/INDIGENT.postman_collection.json) — see [Running the collection](#running-the-collection) at the bottom.
- **Database checks**: [`sql/monitor.sql`](../sql/monitor.sql)

**Prerequisites:** `npm run dev` running on port 5000, and `npm run db:seed` already run.

---

## Step 0 — Reset to a clean slate

Recommended. One draft per user is enforced, so a leftover DRAFT makes step 8 return 400.

In pgAdmin's Query Tool, against `indigent_register`:

```sql
DELETE FROM "Application";
DELETE FROM "Otp";
```

Seeded users survive. Files already written to `uploads/` are orphaned by this — clear that
folder by hand if you want a true clean start.

---

## Step 1 — Server is alive

```
GET http://localhost:5000/api/health
```
No auth, no body. Expect `200`:

```json
{ "status": "ok", "message": "Indigent Register API is running" }
```

This does **not** touch Postgres, so it passing does not prove the database works. Step 2 does.

---

## Step 2 — Admin login

```
POST http://localhost:5000/api/auth/login
```
Body → **raw** → **JSON**:

```json
{ "email": "admin@indigent.gov.za", "password": "admin123" }
```

Expect `200` and `data.user.role === "ADMIN"`.

**Carry forward:** `data.token` → **`adminToken`**. Used from step 20 on.

A `401` here means the seed never ran: `npm run db:seed`.

---

## Step 3 — Applicant login

```
POST http://localhost:5000/api/auth/login
```
```json
{ "email": "john.doe@example.com", "password": "applicant123" }
```

**Carry forward:** `data.token` → **`applicantToken`**. Used for steps 4–19.

---

## Step 4 — Confirm the token works

```
GET http://localhost:5000/api/auth/me
Authorization: Bearer <applicantToken>
```

Expect `200` with John Doe's record, `isVerified: true`, and no password field.

---

## Step 5 — Prove auth is enforced (negative)

Same URL, **remove the Authorization header**.

Expect `401`:
```json
{ "success": false, "message": "Authentication required" }
```

---

## Step 6 — Send OTP

```
POST http://localhost:5000/api/auth/send-otp
```
No auth required.
```json
{ "cellNumber": "0815912000" }
```

Expect `200`. There is no SMS gateway — the code is returned as `demoOtp` and also printed
in your `npm run dev` terminal.

```json
{ "success": true, "message": "OTP sent to number ending in 2000", "demoOtp": "709328" }
```

**Carry forward:** `demoOtp` → **`otpCode`**.

---

## Step 7 — Verify OTP

```
POST http://localhost:5000/api/auth/verify-otp
Authorization: Bearer <applicantToken>
```
```json
{ "cellNumber": "0815912000", "code": "PASTE_otpCode_HERE" }
```

Expect `200`. Send the token even though the route does not require it — with it present,
the route also sets `user.isVerified = true` and writes the cell number onto the user.

**Now send the exact same request again** → `400` "Invalid or expired OTP". OTPs are
single-use and expire after 10 minutes. That replay check is the point of this step.

---

## Step 8 — Create the draft application

```
POST http://localhost:5000/api/applications
Authorization: Bearer <applicantToken>
```
```json
{}
```

Empty body — the route takes no input, copying name / ID / cell from your user record.

Expect `201`.

**Carry forward:**
- `data.id` → **`applicationId`**
- from `data.documents[]`, matching on `type`:
  - `ID_COPY` → **`docIdCopy`**
  - `BANK_STATEMENTS` → **`docBank`**
  - `AFFIDAVIT` → **`docAffidavit`**

Six placeholder rows are always created — three REQUIRED, three OPTIONAL.

> **If you skipped step 0** this returns `400` "You already have a draft application" — but
> the existing draft is returned in `data`, so take the same IDs from there and continue.

**Send it again** → `400`. One draft per user, enforced.

---

## Step 9 — Wizard step 1, applicant particulars

```
PATCH http://localhost:5000/api/applications/<applicationId>
Authorization: Bearer <applicantToken>
```
```json
{
  "maritalStatus": "SINGLE",
  "surname": "Doe",
  "names": "John",
  "idNumber": "9012291111111",
  "cellNumber": "0815912000",
  "cellVerified": true,
  "residentialAddress": "12 Vilakazi Street, Orlando West, Soweto, 1804",
  "postalAddress": "PO Box 91, Sandton, 2196",
  "employmentStatus": "UNEMPLOYED",
  "currentStep": 2
}
```

Expect `200`. **Check `residentialAddress` came back populated** — this is the request that
used to return 500 before the leftover geocode code was removed.

For an employed applicant, swap in:
```json
{
  "employmentStatus": "EMPLOYED",
  "employerName": "Pick n Pay Maponya Mall",
  "employerAddress": "Chris Hani Rd, Soweto, 1818",
  "workTelNumber": "0119381200"
}
```

---

## Step 10 — Wizard step 2, property particulars

Same URL and header.
```json
{
  "peopleOnProperty": 5,
  "childrenUnder18": 2,
  "adults": 2,
  "pensionersOver60": 1,
  "waterMeterNumber": "WM-556677",
  "electricityMeterNumber": "EM-889900",
  "currentStep": 3
}
```

Do this **before** step 11 — `peopleOnProperty` is the divisor for the per-person calculation.

---

## Step 11 — Wizard step 3, household income

Same URL and header.
```json
{
  "salary": 1500.00,
  "oldAgePension": 2000.00,
  "disabilityPension": 0,
  "businessIncome": 0,
  "rentingIncome": 500.00,
  "currentStep": 4
}
```

Expect `200`. **The thing to verify** is that the response contains:

```json
"totalHouseholdIncome": "4000",
"totalIncomePerPerson": "800"
```

Both are computed server-side from the five components, and both come back as **strings**
(Prisma `Decimal` serialises losslessly). Never send those two fields yourself.

To test a household above the R4 200 threshold:
```json
{ "salary": 8000.00, "businessIncome": 1200.00, "oldAgePension": 0, "disabilityPension": 0, "rentingIncome": 0 }
```

---

## Step 12 — Wizard step 4, general information

Same URL and header.
```json
{
  "ownsImmovableProperty": "No",
  "isFullTimeOccupant": "Yes",
  "incomeBelowThreshold": "Yes",
  "hasMunicipalArrears": "Yes",
  "hasArrearsArrangement": "No",
  "currentStep": 5
}
```

Expect `200` with real booleans in the response (`true` / `false`) — the API accepts the UI's
`"Yes"` / `"No"` strings and coerces them.

---

## Step 13 — Submit too early (negative — the important one)

```
POST http://localhost:5000/api/applications/<applicationId>/submit
```
No body. Expect `400`:

```json
{
  "success": false,
  "message": "Please upload all required documents before submitting",
  "missing": ["ID Copy", "Bank Statements", "Affidavit"]
}
```

---

## Step 14 — Upload ID Copy

```
POST http://localhost:5000/api/documents/<applicationId>/upload
Authorization: Bearer <applicantToken>
```

Body → **form-data** (not raw). **Do not set a Content-Type header** — Postman must generate
the multipart boundary itself.

| Key | Type | Value |
|---|---|---|
| `file` | **File** | any local `.pdf` `.jpg` `.jpeg` `.png` `.doc` `.docx`, max 10 MB |
| `documentId` | Text | `<docIdCopy>` |

To change a row's type in Postman, hover over the key field — a **Text ▾** dropdown appears;
switch it to **File**.

Expect `200` with `"status": "Uploaded"` and a `filePath` under `uploads/<applicationId>/`.

Passing `documentId` fills the existing placeholder. Omitting it creates a new OPTIONAL row.

---

## Step 15 — Upload Bank Statements

As step 14, with `documentId` = `<docBank>`.

## Step 16 — Upload Affidavit

As step 14, with `documentId` = `<docAffidavit>`.

---

## Step 17 — Confirm nothing required is outstanding

```
GET http://localhost:5000/api/documents/<applicationId>
```

Expect `200` and six rows. The three REQUIRED ones now read `"status": "Uploaded"`. The three
OPTIONAL ones still read `"Pending"` — correct, and they do not block submission.

---

## Step 18 — Read a file back, and prove it is protected

```
GET http://localhost:5000/api/documents/file/<docIdCopy>
Authorization: Bearer <applicantToken>
```

Postman renders the PDF or image in the response pane. Add `?download=1` for attachment mode.

Then two checks that matter, because these files are ID copies and bank statements:

1. **Remove the Authorization header** and retry → `401`.
2. Open `http://localhost:5000/uploads/<applicationId>/` in a browser → `404`, because the
   unauthenticated static mount was removed.

---

## Step 19 — Submit

```
POST http://localhost:5000/api/applications/<applicationId>/submit
```
No body. Expect `200`, `"status": "PENDING"`, `submittedAt` stamped.

Then **PATCH the application again** with any body → `400` "Only draft applications can be
updated". The record is locked to the applicant from here.

---

## Step 20 — Admin sees it in the queue

Switch to `Authorization: Bearer <adminToken>` for every step below.

```
GET http://localhost:5000/api/admin/applications?status=PENDING&page=1&limit=10
```

Expect your application, pre-formatted for the table UI:

```json
{
  "displayId": "3f3995bf",
  "fullName": "John Doe",
  "totalIncome": "R 4 000,00",
  "totalIncomeRaw": "4000",
  "dateApplied": "2026/08/07",
  "status": "PENDING"
}
```

Also worth trying:
```
?search=9012291111111
?search=john.doe@example.com
?status=ALL
?sortBy=submittedAt&sortOrder=asc
```

DRAFT applications never appear here, by design.

---

## Step 21 — Admin detail and stats

```
GET http://localhost:5000/api/admin/applications/<applicationId>
```
Raw, unformatted record with all documents and the nested user.

```
GET http://localhost:5000/api/admin/stats
```
```json
{ "pending": 1, "approved": 0, "declined": 0, "total": 1 }
```

---

## Step 22 — Approve

```
PATCH http://localhost:5000/api/admin/applications/<applicationId>/status
```
```json
{ "status": "APPROVED", "reviewNotes": "Income verified below threshold. Household qualifies." }
```

Expect `200`, `reviewedBy` set to the admin's user id, `reviewedAt` stamped.

Re-run the stats call → `pending` drops to 0, `approved` rises to 1.

Then send `{ "status": "BOGUS" }` → `400` "Invalid status".

To decline instead:
```json
{ "status": "DECLINED", "reviewNotes": "Household income of R8 000,00 exceeds the R4 200 threshold." }
```

---

## Step 23 — Role boundaries (negative)

With the **applicant** token:
```
GET http://localhost:5000/api/admin/stats     →  403  "Admin access required"
```

With the **admin** token:
```
GET http://localhost:5000/api/applications/mine  →  403  "Applicant access required"
```

---

## Step 24 — Confirm it landed in the database

Open [`sql/monitor.sql`](../sql/monitor.sql) in pgAdmin and run query 3.

One row: `status = APPROVED`, `req_uploaded = 3` of `3`, income `4000.00` and `800.00`,
`reviewedAt` populated. That closes the loop — what Postman wrote is what is on disk.

---

# Running the collection

The same 24 steps, automated as 34 requests across six folders. Tokens and IDs are captured
into collection variables by test scripts, so nothing needs copying by hand.

## Import

**File → Import**, drop in `postman/INDIGENT.postman_collection.json`. No environment file
is needed — the variables live on the collection itself.

To inspect or change them: right-click the collection → **Edit** → **Variables** tab.
`baseUrl` is the one you would change to point at a deployed server.

## Run order

Folders execute top to bottom, and the order matters:

| Folder | Contains |
|---|---|
| `00 - Health` | liveness |
| `01 - Auth` | register, both logins, `/me`, OTP send + verify |
| `02 - Applications` | create draft, the four wizard PATCHes, submit-too-early (**expects 400**) |
| `03 - Documents` | three required uploads, an optional one, list, view, download, delete |
| `04 - Submit` | the real submit (**expects 200**), then PATCH-after-submit (**expects 400**) |
| `05 - Admin` | stats, list, filters, detail, approve, decline, 403 check |

Submit appears twice on purpose: once in folder 02 before any uploads to prove the gate
rejects, once in folder 04 after the uploads to prove it succeeds.

## Two ways to run it

**Request by request** — click a request, hit **Send**, look at the **Test Results** tab
next to the response body. This is the mode to use while you are learning the API.

**All at once** — right-click the collection → **Run collection** → **Run**. You get a pass/fail
report for every assertion.

**Before running it all, attach your three files.** Postman does not export file paths in a
collection (they would leak your local filesystem), so the `file` fields arrive empty. Open
each of the four upload requests in `03 - Documents`, pick a local file in the `file` row,
and **save the request** (Ctrl+S). After that the Runner can send them.

If your test files live outside Postman's working directory, enable
**Settings → General → Allow reading files outside working directory**, or the Runner will
report the file as missing.

## Reading the results

Some requests are **supposed** to fail. A red `400` or `403` next to a green
"1/1 tests passed" is the correct outcome for these seven:

- register with a weak password → 400
- `/me` with no token → 401
- submit before uploads → 400
- PATCH after submit → 400
- admin stats with an applicant token → 403

Judge the run by the **test pass count**, not the status-code colours.

Open the Postman Console (**Ctrl+Alt+C**) to see what the scripts captured — the OTP code,
the application id, and which documents were still pending.

## Re-running

`01 - Auth` and `05 - Admin` are idempotent. The rest are not: `02 - Applications` will 400
on "create draft" because the previous run left one behind, and everything downstream then
operates on that stale draft.

For a clean re-run, execute the step 0 SQL first. The register request is the exception —
it generates a fresh email and ID number each time, so it never collides.

## From the command line

If you want this in CI:

```bash
npm install -g newman
newman run postman/INDIGENT.postman_collection.json
```

The upload requests need real file paths saved in the collection. Either save them from the
Postman UI first and point Newman at the working directory:

```bash
newman run postman/INDIGENT.postman_collection.json --working-dir ./test-files
```

or skip that part and run the folders that need no files:

```bash
newman run postman/INDIGENT.postman_collection.json --folder "00 - Health" --folder "01 - Auth"
```
