-- Fill in date of birth, age and sex for applications that already have an ID.
--
-- These are derived, not asked, so every existing record can have them without
-- anybody re-entering anything. Doing it here rather than lazily on next edit
-- means reporting is complete from the moment the column exists, instead of
-- filling in gradually as people happen to open old applications.
--
-- Only well-formed 13-digit IDs with a real date of birth are touched. Anything
-- else is left null rather than guessed at — a wrong date of birth on an
-- indigent record is worse than a missing one.

UPDATE "Application"
SET
  "dateOfBirth" = make_date(
    CASE
      -- Two-digit years: anything that would place the birth in the future
      -- belongs to the previous century. Matches src/lib/saIdNumber.js.
      WHEN substring("idNumber" from 1 for 2)::int
           <= EXTRACT(YEAR FROM CURRENT_DATE)::int % 100
      THEN 2000 + substring("idNumber" from 1 for 2)::int
      ELSE 1900 + substring("idNumber" from 1 for 2)::int
    END,
    substring("idNumber" from 3 for 2)::int,
    substring("idNumber" from 5 for 2)::int
  ),
  "sex" = CASE
    WHEN substring("idNumber" from 7 for 4)::int < 5000 THEN 'FEMALE'::"Sex"
    ELSE 'MALE'::"Sex"
  END
WHERE "idNumber" ~ '^\d{13}$'
  AND substring("idNumber" from 3 for 2)::int BETWEEN 1 AND 12
  AND substring("idNumber" from 5 for 2)::int BETWEEN 1 AND 31
  AND "dateOfBirth" IS NULL;

-- Age follows from the date of birth just set.
UPDATE "Application"
SET "age" = EXTRACT(YEAR FROM age(CURRENT_DATE, "dateOfBirth"))::int
WHERE "dateOfBirth" IS NOT NULL
  AND "age" IS NULL;

-- Anything that produced an impossible age was a malformed ID that slipped the
-- pattern above. Clear it rather than leave a wrong figure on the record.
UPDATE "Application"
SET "dateOfBirth" = NULL, "age" = NULL, "sex" = NULL
WHERE "age" IS NOT NULL AND ("age" < 0 OR "age" > 130);

-- hasDisability is deliberately left null. Nobody has been asked the six
-- questions yet, and null means "not asked" — recording it as false would
-- understate prevalence with data that was never collected.
