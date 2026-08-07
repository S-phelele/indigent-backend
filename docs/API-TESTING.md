# Indigent Register API — Testing Reference

Every endpoint with a copy-paste request body and the real response it returns.
All samples below were captured from a live run against `http://localhost:5000`,
not written by hand.

- **Base URL:** `http://localhost:5000`
- **Postman collection:** [`postman/INDIGENT.postman_collection.json`](../postman/INDIGENT.postman_collection.json)
- **pgAdmin queries:** [`sql/monitor.sql`](../sql/monitor.sql)

---

## Conventions

**Auth header** — every protected route wants a JWT from `/api/auth/login`:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

In Postman, set the body type to **raw → JSON** for everything except file uploads,
which use **form-data**.

**Response envelope** — consistent across the whole API:

```json
{ "success": true, "message": "...", "data": { } }
```

**Seeded accounts** (from `npm run db:seed`):

| Role | Email | Password |
|---|---|---|
| ADMIN | `admin@indigent.gov.za` | `admin123` |
| APPLICANT | `john.doe@example.com` | `applicant123` |

**Enum values** — sending anything else is silently ignored on PATCH, or rejected on create:

| Field | Allowed values |
|---|---|
| `role` | `APPLICANT`, `ADMIN` |
| `status` (application) | `DRAFT`, `PENDING`, `APPROVED`, `DECLINED` |
| `maritalStatus` | `SINGLE`, `MARRIED`, `DIVORCED`, `WIDOWED`, `SEPARATED` |
| `employmentStatus` | `EMPLOYED`, `UNEMPLOYED`, `SELF_EMPLOYED`, `PENSIONER`, `OTHER` |
| `type` (document) | `ID_COPY`, `BANK_STATEMENTS`, `AFFIDAVIT`, `PROOF_OF_GRANT`, `COPY_OF_DEATH_CERT`, `LETTER_OF_AUTHORITY`, `OTHER` |
| `importance` | `REQUIRED`, `OPTIONAL` |
| `status` (document) | `Pending`, `Uploaded`, `Rejected` — plain strings, not an enum |

**Three gotchas that will confuse you if you don't know them:**

1. **Decimal fields come back as JSON strings.** `"totalHouseholdIncome": "4000"`, not `4000`.
   That is Prisma's `Decimal` type serializing losslessly. Wrap in `Number()` on the frontend.
2. **Yes/No is accepted for booleans.** `"Yes"`, `"No"`, `true`, `false`, `"true"`, `"false"` all work.
   Anything else is dropped silently rather than erroring.
3. **Unknown fields are ignored, not rejected.** The PATCH route whitelists keys, so a typo
   in a field name fails silently — the request returns 200 and nothing was saved.

---

# 1. Health

## `GET /api/health`

No auth. Does not touch the database — returns 200 even if Postgres is down.

**Response `200`**
```json
{
  "status": "ok",
  "message": "Indigent Register API is running"
}
```

---

# 2. Auth

## `POST /api/auth/register`

No auth. Creates an APPLICANT and returns a usable JWT immediately — there is no
email confirmation step.

**Body**
```json
{
  "email": "thabo.mokoena@example.com",
  "password": "Test@1234",
  "firstName": "Thabo",
  "lastName": "Mokoena",
  "cellNumber": "0821234567",
  "idNumber": "9203155555088"
}
```

Only `email` and `password` are required. `email` and `idNumber` must each be unique,
so change them on every re-run or you will get a 400.

**Password rules:** minimum 8 characters, at least one uppercase, at least one lowercase,
at least one special character. **A digit is _not_ required** — `Password@` passes.

**Response `201`**
```json
{
  "success": true,
  "message": "Registration successful",
  "data": {
    "user": {
      "id": "b59a1cfa-5fbf-4079-84da-d6fccae4fc88",
      "email": "thabo.mokoena@example.com",
      "role": "APPLICANT",
      "firstName": "Thabo",
      "lastName": "Mokoena",
      "cellNumber": "0821234567"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**Weak password → `400`** — the message names every rule that failed:
```json
{
  "success": false,
  "message": "Password must include at least 8 characters, a capital letter, a special character (e.g. @, !, #, %, &)"
}
```

**Duplicate → `400`**
```json
{ "success": false, "message": "Email or ID number already registered" }
```

---

## `POST /api/auth/login`

No auth. Token is valid for 7 days (`JWT_EXPIRES_IN`).

**Body — applicant**
```json
{
  "email": "john.doe@example.com",
  "password": "applicant123"
}
```

**Body — admin**
```json
{
  "email": "admin@indigent.gov.za",
  "password": "admin123"
}
```

**Response `200`**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": "fbcaaeed-1cb5-42c2-92e1-270c3fdccef9",
      "email": "john.doe@example.com",
      "role": "APPLICANT",
      "firstName": "John",
      "lastName": "Doe",
      "cellNumber": "0815912000",
      "idNumber": "9012291111111",
      "isVerified": true
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**Wrong password → `401`** — deliberately does not reveal whether the email exists:
```json
{ "success": false, "message": "Invalid email or password" }
```

---

## `POST /api/auth/send-otp`

No auth. **No SMS gateway is wired up.** The code is printed to the server console and
returned in the response as `demoOtp` because `NODE_ENV=development`. Any previously
unused OTP for the same number is invalidated first.

**Body**
```json
{
  "cellNumber": "0815912000"
}
```

**Response `200`**
```json
{
  "success": true,
  "message": "OTP sent to number ending in 2000",
  "demoOtp": "709328"
}
```

Cell number shorter than 10 characters → `400`.

---

## `POST /api/auth/verify-otp`

Auth optional, but **send the applicant token anyway** — if an `Authorization` header is
present the route also sets `user.isVerified = true` and writes the cell number onto the
user record. Without it, only the OTP row is consumed.

**Body**
```json
{
  "cellNumber": "0815912000",
  "code": "709328"
}
```

**Response `200`**
```json
{ "success": true, "message": "OTP verified successfully" }
```

**Wrong, expired, or already-used code → `400`.** OTPs are single-use and expire after
10 minutes (`OTP_EXPIRY_MINUTES`), so replaying a successful request returns:
```json
{ "success": false, "message": "Invalid or expired OTP" }
```

---

## `GET /api/auth/me`

Requires any valid token. Re-reads the user from the database, so it reflects changes
made since the token was issued. Useful for checking whether a token is still alive.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "id": "fbcaaeed-1cb5-42c2-92e1-270c3fdccef9",
    "email": "john.doe@example.com",
    "role": "APPLICANT",
    "firstName": "John",
    "lastName": "Doe",
    "cellNumber": "0815912000",
    "idNumber": "9012291111111",
    "isVerified": true
  }
}
```

**No token → `401`**
```json
{ "success": false, "message": "Authentication required" }
```

**Bad or expired token → `401`**
```json
{ "success": false, "message": "Invalid or expired token" }
```

---

# 3. Applications (APPLICANT only)

## `POST /api/applications`

Creates the draft. **Send an empty body `{}`** — it takes no input. It copies
surname / names / idNumber / cellNumber off your user record and auto-creates six
document placeholder rows.

**Body**
```json
{}
```

**Response `201`** (documents array trimmed to two of six here)
```json
{
  "success": true,
  "data": {
    "id": "3f3995bf-f285-4b69-8cc6-ac99635dee10",
    "userId": "fbcaaeed-1cb5-42c2-92e1-270c3fdccef9",
    "status": "DRAFT",
    "currentStep": 1,
    "surname": "Doe",
    "names": "John",
    "idNumber": "9012291111111",
    "cellNumber": "0815912000",
    "cellVerified": false,
    "maritalStatus": null,
    "residentialAddress": null,
    "salary": null,
    "totalHouseholdIncome": null,
    "submittedAt": null,
    "createdAt": "2026-08-06T18:09:22.699Z",
    "documents": [
      {
        "id": "bcae9e87-bb61-4b68-86f9-79a879d8fd07",
        "applicationId": "3f3995bf-f285-4b69-8cc6-ac99635dee10",
        "name": "ID Copy",
        "type": "ID_COPY",
        "importance": "REQUIRED",
        "fileName": null,
        "filePath": null,
        "mimeType": null,
        "fileSize": null,
        "status": "Pending",
        "uploadedAt": null
      },
      {
        "id": "ccece400-598e-4237-bf9b-e0812e11111c",
        "name": "Proof of Grant",
        "type": "PROOF_OF_GRANT",
        "importance": "OPTIONAL",
        "status": "Pending"
      }
    ]
  }
}
```

The six placeholders are always created in this order — **grab these IDs**, you need them
for uploads:

| Name | type | importance |
|---|---|---|
| ID Copy | `ID_COPY` | REQUIRED |
| Bank Statements | `BANK_STATEMENTS` | REQUIRED |
| Affidavit | `AFFIDAVIT` | REQUIRED |
| Proof of Grant | `PROOF_OF_GRANT` | OPTIONAL |
| Copy of Death Certificate | `COPY_OF_DEATH_CERT` | OPTIONAL |
| Letter of Authority | `LETTER_OF_AUTHORITY` | OPTIONAL |

**Second draft → `400`.** One draft per user. Note the existing draft is returned in
`data`, so you can recover from this without another call:
```json
{
  "success": false,
  "message": "You already have a draft application. Please complete and submit it before starting a new one.",
  "data": { "id": "3f3995bf-...", "status": "DRAFT", "currentStep": 1 }
}
```

**Admin token → `403`** (`requireApplicant`).

---

## `PATCH /api/applications/:id` — Step 1, Applicant Particulars

Every field is optional and independently saved, so partial saves are safe. Empty strings
and nulls are dropped rather than written. Only `DRAFT` applications can be patched.

**URL:** `http://localhost:5000/api/applications/3f3995bf-f285-4b69-8cc6-ac99635dee10`

**Body**
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
  "employerName": "",
  "employerAddress": "",
  "workTelNumber": "",
  "currentStep": 2
}
```

`currentStep` is clamped to 1–5; anything outside that range is ignored.

**Response `200`** — the full application plus its documents. Confirm the fields you sent:
```json
{
  "success": true,
  "data": {
    "id": "3f3995bf-f285-4b69-8cc6-ac99635dee10",
    "status": "DRAFT",
    "currentStep": 2,
    "maritalStatus": "SINGLE",
    "surname": "Doe",
    "names": "John",
    "residentialAddress": "12 Vilakazi Street, Orlando West, Soweto, 1804",
    "postalAddress": "PO Box 91, Sandton, 2196",
    "employmentStatus": "UNEMPLOYED",
    "cellVerified": true,
    "documents": []
  }
}
```

If the applicant is employed, swap in:
```json
{
  "employmentStatus": "EMPLOYED",
  "employerName": "Pick n Pay Maponya Mall",
  "employerAddress": "Chris Hani Rd, Soweto, 1818",
  "workTelNumber": "0119381200"
}
```

---

## `PATCH /api/applications/:id` — Step 2, Property Particulars

Integers only. Save `peopleOnProperty` **before** step 3 — it is the divisor for the
per-person income calculation.

**Body**
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

**Response `200`**
```json
{
  "success": true,
  "data": {
    "peopleOnProperty": 5,
    "childrenUnder18": 2,
    "adults": 2,
    "pensionersOver60": 1,
    "waterMeterNumber": "WM-556677",
    "electricityMeterNumber": "EM-889900",
    "currentStep": 3
  }
}
```

---

## `PATCH /api/applications/:id` — Step 3, Household Income

**Do not send `totalHouseholdIncome` or `totalIncomePerPerson`.** The server recomputes
both whenever any of the five income components is present:

```
totalHouseholdIncome = salary + oldAgePension + disabilityPension + businessIncome + rentingIncome
totalIncomePerPerson = totalHouseholdIncome / peopleOnProperty
```

**Body**
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

**Response `200`** — note the totals are computed, and every Decimal is a **string**:
```json
{
  "success": true,
  "data": {
    "salary": "1500",
    "oldAgePension": "2000",
    "disabilityPension": "0",
    "businessIncome": "0",
    "rentingIncome": "500",
    "peopleOnProperty": 5,
    "totalHouseholdIncome": "4000",
    "totalIncomePerPerson": "800",
    "currentStep": 4
  }
}
```

To test a household **above** the R4 200 threshold:
```json
{
  "salary": 8000.00,
  "oldAgePension": 0,
  "disabilityPension": 0,
  "businessIncome": 1200.00,
  "rentingIncome": 0
}
```

---

## `PATCH /api/applications/:id` — Step 4, General Information

Booleans, sent as the UI's Yes/No strings.

**Body**
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

Real JSON booleans work identically:
```json
{
  "ownsImmovableProperty": false,
  "isFullTimeOccupant": true,
  "incomeBelowThreshold": true,
  "hasMunicipalArrears": true,
  "hasArrearsArrangement": false
}
```

**Response `200`** — coerced to real booleans:
```json
{
  "success": true,
  "data": {
    "ownsImmovableProperty": false,
    "isFullTimeOccupant": true,
    "incomeBelowThreshold": true,
    "hasMunicipalArrears": true,
    "hasArrearsArrangement": false,
    "currentStep": 5
  }
}
```

**Patching a submitted application → `400`**
```json
{ "success": false, "message": "Only draft applications can be updated" }
```

---

## `POST /api/applications/:id/submit`

No body. `DRAFT → PENDING`, stamps `submittedAt`, forces `currentStep` to 5.

**URL:** `http://localhost:5000/api/applications/3f3995bf-f285-4b69-8cc6-ac99635dee10/submit`

**Response `200`**
```json
{
  "success": true,
  "message": "Application submitted successfully",
  "data": {
    "id": "3f3995bf-f285-4b69-8cc6-ac99635dee10",
    "status": "PENDING",
    "submittedAt": "2026-08-06T16:38:36.353Z",
    "currentStep": 5
  }
}
```

**Missing documents → `400`.** The response tells you exactly which ones:
```json
{
  "success": false,
  "message": "Please upload all required documents before submitting",
  "missing": ["ID Copy", "Bank Statements", "Affidavit"]
}
```

**Missing particulars → `400`** (needs `surname`, `idNumber` and `cellNumber`):
```json
{
  "success": false,
  "message": "Please complete all required applicant particulars (surname, ID number, cell number)"
}
```

**Already submitted → `400`**
```json
{ "success": false, "message": "Application already submitted" }
```

---

## `GET /api/applications/mine`

APPLICANT only. All of the caller's applications with their documents, newest first.
Admins get 403 here — they use `/api/admin/applications`.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "id": "3f3995bf-f285-4b69-8cc6-ac99635dee10",
      "status": "DRAFT",
      "currentStep": 4,
      "totalHouseholdIncome": "4000",
      "documents": []
    }
  ]
}
```

---

## `GET /api/applications/:id`

Owner **or** admin — the only applicant route that admins can also call. Includes the
nested `user` object.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "id": "3f3995bf-f285-4b69-8cc6-ac99635dee10",
    "status": "DRAFT",
    "documents": [],
    "user": {
      "id": "fbcaaeed-1cb5-42c2-92e1-270c3fdccef9",
      "email": "john.doe@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "cellNumber": "0815912000",
      "idNumber": "9012291111111"
    }
  }
}
```

**Someone else's application → `403`**
```json
{ "success": false, "message": "Access denied" }
```

---

# 4. Documents

## `POST /api/documents/:applicationId/upload`

**Body type: form-data, not raw JSON.** Do **not** set `Content-Type` yourself —
Postman must generate the multipart boundary.

**URL:** `http://localhost:5000/api/documents/3f3995bf-f285-4b69-8cc6-ac99635dee10/upload`

| Key | Type | Value |
|---|---|---|
| `file` | **File** | pick a local file |
| `documentId` | Text | `bcae9e87-bb61-4b68-86f9-79a879d8fd07` |

Allowed extensions: `.pdf` `.jpg` `.jpeg` `.png` `.doc` `.docx`. Max 10 MB.
Files land in `uploads/<applicationId>/<uuid><ext>`.

Passing `documentId` **fills the existing placeholder** — this is what you want for the
three required documents. It also deletes the old file first if you are replacing one.

To create a **new** row instead, omit `documentId` and send `type`:

| Key | Type | Value |
|---|---|---|
| `file` | **File** | pick a local file |
| `type` | Text | `PROOF_OF_GRANT` |

The new row gets `importance: OPTIONAL` and takes its name from the filename.
Omitting `type` defaults to `OTHER`.

**Response `200`**
```json
{
  "success": true,
  "message": "Document uploaded successfully",
  "data": {
    "id": "bcae9e87-bb61-4b68-86f9-79a879d8fd07",
    "applicationId": "3f3995bf-f285-4b69-8cc6-ac99635dee10",
    "name": "ID Copy",
    "type": "ID_COPY",
    "importance": "REQUIRED",
    "fileName": "id-copy.pdf",
    "filePath": "uploads\\3f3995bf-f285-4b69-8cc6-ac99635dee10\\ee016b95-3863-4bc3-ab04-aec12e0caa78.pdf",
    "mimeType": "application/pdf",
    "fileSize": 69,
    "status": "Uploaded",
    "uploadedAt": "2026-08-06T18:09:23.376Z"
  }
}
```

**No file attached → `400`**
```json
{ "success": false, "message": "No file uploaded" }
```

**Disallowed extension → `500`** (not 400 — multer's error carries no status, so the
global handler defaults it):
```json
{ "success": false, "message": "Invalid file type. Allowed: PDF, JPG, PNG, DOC, DOCX" }
```

**Uploading to a submitted application → `400`** for applicants; admins are exempt.

---

## `GET /api/documents/:applicationId`

Owner or admin. Use this to see which required documents are still `Pending` before
submitting.

**Response `200`**
```json
{
  "success": true,
  "data": [
    {
      "id": "bcae9e87-bb61-4b68-86f9-79a879d8fd07",
      "name": "ID Copy",
      "type": "ID_COPY",
      "importance": "REQUIRED",
      "status": "Uploaded",
      "fileName": "id-copy.pdf",
      "fileSize": 69,
      "uploadedAt": "2026-08-06T18:09:23.376Z"
    },
    {
      "id": "52dd25a1-21b2-4a9f-afa3-cde3d9bdeabe",
      "name": "Bank Statements",
      "type": "BANK_STATEMENTS",
      "importance": "REQUIRED",
      "status": "Pending",
      "fileName": null,
      "uploadedAt": null
    }
  ]
}
```

---

## `GET /api/documents/file/:documentId`

Streams the actual file, authenticated and ownership-checked. Postman previews images
and PDFs in the response pane.

**URL:** `http://localhost:5000/api/documents/file/bcae9e87-bb61-4b68-86f9-79a879d8fd07`

Add `?download=1` (or `?download=true`) to get `Content-Disposition: attachment`
instead of `inline`.

Returns the raw bytes with the stored `mimeType`, not JSON. This is the **only** way to
read an uploaded file — `/uploads` is deliberately not served statically, since these are
ID copies and bank statements.

**Not uploaded yet → `404`**
```json
{ "success": false, "message": "File not uploaded yet" }
```

**Row exists but file is gone from disk → `404`**
```json
{ "success": false, "message": "File missing on server" }
```

---

## `DELETE /api/documents/:documentId`

**Despite the verb, this does not delete the row.** It unlinks the file from disk and
resets the row to `Pending` with null file fields, so the placeholder survives for
re-upload. No body.

**Response `200`**
```json
{ "success": true, "message": "Document removed" }
```

Note this is **not** blocked on submitted applications — an applicant can currently strip
a document off a PENDING application.

---

# 5. Admin (ADMIN token only)

Every route here returns `403` for an applicant token:
```json
{ "success": false, "message": "Admin access required" }
```

## `GET /api/admin/stats`

No parameters. Drafts are excluded from `total`.

**Response `200`**
```json
{
  "success": true,
  "data": { "pending": 0, "approved": 1, "declined": 0, "total": 1 }
}
```

---

## `GET /api/admin/applications`

**DRAFT applications are never returned here** — admins only see submitted work.

**URL with all parameters:**
```
http://localhost:5000/api/admin/applications?status=ALL&search=&page=1&limit=10&sortBy=createdAt&sortOrder=desc
```

| Param | Values | Notes |
|---|---|---|
| `status` | `PENDING` `APPROVED` `DECLINED` `ALL` | anything not an exact status falls back to all non-draft |
| `search` | free text | case-insensitive contains on surname, names, idNumber, cellNumber, user email |
| `page` | integer | defaults to 1 |
| `limit` | integer | defaults to 10, clamped to 1–100 |
| `sortBy` | column name | passed straight to Prisma — **an invalid name returns 500** |
| `sortOrder` | `asc` `desc` | anything not `asc` becomes `desc` |

Useful variants to try:
```
?status=PENDING&page=1&limit=10
?search=9012291111111
?search=john.doe@example.com
?sortBy=submittedAt&sortOrder=asc
```

**Response `200`** — pre-formatted for the table UI:
```json
{
  "success": true,
  "data": [
    {
      "id": "d53d6cf4-45b2-4fd0-9d59-589c42f1267e",
      "displayId": "d53d6cf4",
      "fullName": "John Doe",
      "cellNumber": "0815912000",
      "employmentStatus": "UNEMPLOYED",
      "totalIncome": "R 4 000,00",
      "totalIncomeRaw": "4000",
      "dateApplied": "2026/08/06",
      "status": "APPROVED",
      "documents": [
        { "id": "a0c5b638-...", "name": "ID Copy", "type": "ID_COPY", "status": "Uploaded", "importance": "REQUIRED" },
        { "id": "9bee2bb7-...", "name": "Proof of Grant", "type": "PROOF_OF_GRANT", "status": "Pending", "importance": "OPTIONAL" }
      ],
      "user": {
        "id": "fbcaaeed-1cb5-42c2-92e1-270c3fdccef9",
        "email": "john.doe@example.com",
        "firstName": "John",
        "lastName": "Doe"
      },
      "createdAt": "2026-08-06T16:38:35.828Z",
      "submittedAt": "2026-08-06T16:38:36.353Z"
    }
  ],
  "pagination": { "page": 1, "limit": 5, "total": 1, "totalPages": 1 }
}
```

`totalIncome` is already rendered in `en-ZA` — space as thousands separator, comma as
decimal. `totalIncomeRaw` carries the unformatted value (as a string). `dateApplied`
is `YYYY/MM/DD`.

---

## `GET /api/admin/applications/:id`

Raw, unformatted application with all documents and the applicant's user record —
the detail view behind a row in the table.

**Response `200`**
```json
{
  "success": true,
  "data": {
    "id": "d53d6cf4-45b2-4fd0-9d59-589c42f1267e",
    "status": "APPROVED",
    "surname": "Doe",
    "names": "John",
    "idNumber": "9012291111111",
    "residentialAddress": "12 Vilakazi Street, Orlando West, Soweto",
    "totalHouseholdIncome": "4000",
    "totalIncomePerPerson": "800",
    "peopleOnProperty": 5,
    "submittedAt": "2026-08-06T16:38:36.353Z",
    "reviewedAt": "2026-08-06T16:38:36.820Z",
    "reviewedBy": "9c357ce9-e6aa-4208-ad0a-4878c4d4e8fe",
    "reviewNotes": "Income verified below threshold.",
    "documents": [],
    "user": {}
  }
}
```

---

## `PATCH /api/admin/applications/:id/status`

Approve, decline, or push back to the queue. Stamps `reviewedAt`, `reviewedBy`
(the admin's user id) and `reviewNotes`.

**URL:** `http://localhost:5000/api/admin/applications/d53d6cf4-45b2-4fd0-9d59-589c42f1267e/status`

**Body — approve**
```json
{
  "status": "APPROVED",
  "reviewNotes": "Income verified below threshold. Household qualifies."
}
```

**Body — decline**
```json
{
  "status": "DECLINED",
  "reviewNotes": "Household income of R8 000,00 exceeds the R4 200 threshold."
}
```

**Body — send back to the queue**
```json
{
  "status": "PENDING",
  "reviewNotes": "Bank statements illegible, requesting re-upload."
}
```

`reviewNotes` is optional and stored as `null` when omitted.

**Response `200`**
```json
{
  "success": true,
  "message": "Application approved successfully",
  "data": {
    "id": "d53d6cf4-45b2-4fd0-9d59-589c42f1267e",
    "status": "APPROVED",
    "reviewedAt": "2026-08-06T16:38:36.820Z",
    "reviewedBy": "9c357ce9-e6aa-4208-ad0a-4878c4d4e8fe",
    "reviewNotes": "Income verified below threshold. Household qualifies.",
    "documents": [],
    "user": { "email": "john.doe@example.com", "firstName": "John", "lastName": "Doe" }
  }
}
```

**Any other status → `400`**
```json
{ "success": false, "message": "Invalid status" }
```

There is no guard requiring the application to be PENDING first, so a DRAFT can be
approved directly through this endpoint.

---

# Full happy path

Run in this order. Each step feeds the next.

| # | Request | Carry forward |
|---|---|---|
| 1 | `POST /api/auth/login` (admin) | `adminToken` |
| 2 | `POST /api/auth/login` (applicant) | `applicantToken` |
| 3 | `POST /api/auth/send-otp` | `demoOtp` |
| 4 | `POST /api/auth/verify-otp` | — |
| 5 | `POST /api/applications` | `applicationId`, 3 required doc IDs |
| 6 | `PATCH /api/applications/:id` step 1 | — |
| 7 | `PATCH /api/applications/:id` step 2 | — |
| 8 | `PATCH /api/applications/:id` step 3 | — |
| 9 | `PATCH /api/applications/:id` step 4 | — |
| 10 | `POST /api/documents/:id/upload` × 3 | — |
| 11 | `GET /api/documents/:id` | confirm nothing REQUIRED is Pending |
| 12 | `POST /api/applications/:id/submit` | status → PENDING |
| 13 | `GET /api/admin/applications?status=PENDING` | it appears in the queue |
| 14 | `PATCH /api/admin/applications/:id/status` | status → APPROVED |
| 15 | `GET /api/admin/stats` | counters move |

The Postman collection chains all of this automatically — tokens and IDs are captured
into collection variables by test scripts, so you only need to attach files at step 10.

---

# Error reference

| Status | Meaning | Typical cause |
|---|---|---|
| `400` | Bad request | validation failure, wrong state, duplicate draft, missing documents |
| `401` | Unauthenticated | no `Authorization` header, malformed header, expired token, wrong password |
| `403` | Wrong role or not the owner | applicant hitting `/api/admin/*`, admin hitting `/mine`, accessing another user's application |
| `404` | Not found | bad UUID, or the file row exists but the file is gone from disk |
| `500` | Server error | disallowed upload extension, invalid `sortBy`, or a genuine bug — check the server console |
