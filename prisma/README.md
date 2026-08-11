# The database

One migration builds the whole thing. Clone the repo, set `DATABASE_URL`, and:

```sh
npm run db:setup
```

That checks your configuration, reaches the database, applies the schema,
generates the client, proves the audit trail is protected, and creates one
account per role. If any step fails it says which one and stops, rather than
leaving a half-built database that looks like broken code.

## Why there is only one migration

There were nineteen, written as the register was built. Each was correct, but a
new developer had to replay all of them in order, and one failure part-way
through produced a database that was neither empty nor complete — the state
that generates "it doesn't work on my machine".

`prisma/migrations/00000000000000_baseline/migration.sql` replaces them. It is
the same database, built in one step.

## The part that is easy to lose

The baseline has two halves, separated by a rule near the bottom.

**Above it** is generated from `schema.prisma` and can be regenerated at any
time.

**Below it** cannot be. The append-only guarantees on the audit trail are
PostgreSQL functions and triggers, and Prisma's schema language cannot express
them. Squashing by regenerating from the schema alone produces tables that look
right and silently drops all eight triggers — a fresh database would let anybody
edit the audit trail, with no error and nothing on screen to notice.

**If you add a trigger, function, view or grant, put it below the rule.**
Anything not expressible in `schema.prisma` has to live there or it will not
survive the next squash.

`npm run verify:audit` proves the protection is real against whatever database
you are pointed at. `db:setup` runs it for you.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run db:setup` | Everything, from nothing. Safe to re-run. |
| `npm run db:deploy` | Apply pending migrations. No data loss. |
| `npm run db:generate` | Regenerate the Prisma client after a schema change. |
| `npm run db:seed` | Create or reset the seven development accounts. |
| `npm run db:demo:remove` | Take those accounts out again. |
| `npm run db:reset` | **Drops everything**, rebuilds, reseeds. Local only. |
| `npm run db:studio` | Browse the data. |
| `npm run verify:audit` | Prove the audit trail cannot be edited. |
| `npm run verify:workflow` | Drive an application through the whole chain. |

## Changing the schema

```sh
# 1. Edit prisma/schema.prisma, then:
npx prisma migrate dev --name what_you_changed

# 2. Commit BOTH the schema and the new migration folder.
```

A migration that is not committed is a database only you have. That is the
problem this layout exists to prevent, so the two always travel together.

Stop the backend before `prisma generate` — a running server holds the query
engine open and Windows will not let it be replaced. `db:setup` detects this and
tells you, rather than failing obscurely.

## If your database predates the squash

Anybody whose database was built by the old nineteen migrations needs this once:

```sh
node scripts/adopt-baseline.js
```

Prisma records applied migrations by name. Those nineteen names no longer exist
on disk and the baseline has never been recorded, so `migrate deploy` would try
to create tables that already exist and fail on the first one.

The script fixes the bookkeeping, not the schema. **No DDL runs and no data is
touched** — it replaces the nineteen recorded rows with one saying the baseline
is already applied. It refuses if your database does not actually match the
schema, because marking it as applied would otherwise be a lie that surfaces
later as a much harder failure.

A fresh clone does not need it. `db:setup` applies the baseline to an empty
database and there is nothing to adopt.

## Development accounts

Seven, one per role, password `Demo@2026`. Separate people on purpose: the
approval chain enforces separation of duties, so whoever verified an application
may not also assess it. A single admin account cannot walk a case through the
chain, which is the main thing worth testing.

They are development credentials with a published password and must not exist on
a live register. `npm run db:demo:remove` takes them out, and refuses to delete
an account that has work attached rather than cascading it away.
