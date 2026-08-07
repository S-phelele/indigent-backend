-- Indigent Register — pgAdmin monitoring queries
--
-- Open in pgAdmin 4: connect to the `indigent_register` database, then
-- Tools > Query Tool, open this file, put the cursor in a statement and press F5.
--
-- NOTE: Prisma creates PascalCase table and column names, so every identifier
-- MUST be double-quoted. `SELECT * FROM User` is a syntax error;
-- `SELECT * FROM "User"` is correct.

-- ---------------------------------------------------------------------------
-- 1. Users
-- ---------------------------------------------------------------------------
SELECT id, email, role, "firstName", "lastName", "cellNumber", "idNumber",
       "isVerified", "createdAt"
FROM "User"
ORDER BY "createdAt" DESC;


-- ---------------------------------------------------------------------------
-- 2. Latest OTP codes
-- Faster than tailing the server console while testing the OTP flow in Postman.
-- ---------------------------------------------------------------------------
SELECT "cellNumber", code, used, "expiresAt",
       ("expiresAt" > NOW() AND NOT used) AS still_valid,
       "createdAt"
FROM "Otp"
ORDER BY "createdAt" DESC
LIMIT 10;


-- ---------------------------------------------------------------------------
-- 3. Application pipeline, with required-document progress
-- The single most useful view: shows where each application is stuck.
-- ---------------------------------------------------------------------------
SELECT a.id,
       LEFT(a.id::text, 8)                AS display_id,
       a.status,
       a."currentStep",
       CONCAT_WS(' ', a.names, a.surname) AS full_name,
       a."idNumber",
       a."totalHouseholdIncome",
       a."totalIncomePerPerson",
       u.email,
       COUNT(d.id) FILTER (WHERE d.importance = 'REQUIRED' AND d.status = 'Uploaded') AS req_uploaded,
       COUNT(d.id) FILTER (WHERE d.importance = 'REQUIRED')                           AS req_total,
       a."submittedAt",
       a."reviewedAt"
FROM "Application" a
JOIN "User" u        ON u.id = a."userId"
LEFT JOIN "Document" d ON d."applicationId" = a.id
GROUP BY a.id, u.email
ORDER BY a."createdAt" DESC;


-- ---------------------------------------------------------------------------
-- 4. Status breakdown (mirrors GET /api/admin/stats)
-- ---------------------------------------------------------------------------
SELECT status, COUNT(*) AS count
FROM "Application"
GROUP BY status
ORDER BY status;


-- ---------------------------------------------------------------------------
-- 5. Documents for one application
-- Replace the id with the one Postman captured into {{applicationId}}.
-- ---------------------------------------------------------------------------
SELECT name, type, importance, status, "fileName", "fileSize", "filePath", "uploadedAt"
FROM "Document"
WHERE "applicationId" = 'PASTE-APPLICATION-ID-HERE'
ORDER BY importance, "createdAt";


-- ---------------------------------------------------------------------------
-- 6. Orphaned document rows — marked Uploaded but the file is gone from disk
-- (Postgres cannot stat the filesystem; check these paths by hand.)
-- ---------------------------------------------------------------------------
SELECT d.id, d.name, d."filePath", a.status AS application_status
FROM "Document" d
JOIN "Application" a ON a.id = d."applicationId"
WHERE d.status = 'Uploaded' AND d."filePath" IS NOT NULL
ORDER BY d."uploadedAt" DESC;


-- ---------------------------------------------------------------------------
-- 7. Live server activity — what Prisma is doing right now
-- The Dashboard tab on the database node shows this graphically.
-- ---------------------------------------------------------------------------
SELECT pid, state, query_start, LEFT(query, 120) AS query
FROM pg_stat_activity
WHERE datname = 'indigent_register' AND state <> 'idle'
ORDER BY query_start DESC;


-- ---------------------------------------------------------------------------
-- 8. Reset test data — deletes ALL applications (cascades to documents).
-- Seeded users survive. Uncomment to run. Files on disk are NOT removed;
-- clear ./uploads by hand.
-- ---------------------------------------------------------------------------
-- DELETE FROM "Application";
-- DELETE FROM "Otp";
