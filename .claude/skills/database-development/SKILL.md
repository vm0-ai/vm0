---
name: database-development
description: Database migrations and Drizzle ORM guidelines for the vm0 project
---

# Database Development

## Commands

```bash
cd turbo/packages/db

pnpm db:generate   # Generate migration from schema changes
pnpm db:migrate    # Run pending migrations
pnpm db:studio     # Open Drizzle Studio UI
```

## Migration Workflows

### Auto-Generated (simple changes)

```bash
# 1. Edit schema in src/schema/
# 2. Generate migration (auto-updates _journal.json and snapshot)
pnpm db:generate
# 3. Run locally
pnpm db:migrate
```

### Custom SQL (renames, complex ALTER, data transforms)

Use `drizzle-kit generate --custom` to create an empty migration file managed by Drizzle.
This auto-updates `_journal.json` and snapshot — **never edit these manually**.

```bash
# 1. Generate empty migration file
pnpm drizzle-kit generate --custom --name=rename_foo_to_bar
# 2. Write SQL in the generated file
# 3. Update schema file to match
# 4. Run locally
pnpm db:migrate
```

## Data Migration Scripts (Clerk API)

When a data migration requires **external API calls** (e.g., reading from Clerk),
it cannot be done in a SQL migration. These scripts live in:

```
turbo/packages/db/scripts/migrations/NNN-description/
├── backfill.ts   # (or sync.ts) — the migration script
└── README.md     # Usage, prerequisites, verification steps
```

Pure data transforms that only touch the database should use regular SQL migrations instead.

### Convention

- **Numbered sequentially**: `001-`, `002-`, etc. — never reuse numbers
- **Permanent**: these scripts are historical records and MUST NOT be deleted,
  even after the migration is complete and the referenced tables/schemas no longer exist
- **Default dry-run**: use `parseArgs` with `--migrate` flag; default mode is dry-run
- **Self-contained**: each directory has its own README with usage instructions
- **Excluded from CI**: completed scripts that reference deleted schemas are excluded
  from `tsconfig.json` and `eslint.config.js` to avoid build errors

## Database Result Boundaries

Drizzle's `sql<T>`, `SQL<T>`, generic `.as<T>()`, `execute<Row>`, and TypeScript
assertions only change compile-time types. They do not validate or decode
PostgreSQL driver values. Never use them to declare a database result contract.

### Structured Selections

For every raw expression selected by `select`, `selectDistinct`,
`selectDistinctOn`, `returning`, or relational-query `extras`, choose the first
applicable runtime boundary:

1. Prefer a schema column or a Drizzle helper such as `count()` that already
   owns the correct decoder.
2. Use `.mapWith(column)` when the expression has exactly the same PostgreSQL
   runtime representation as that column.
3. Use `.mapWith(decoder)` for a dedicated runtime contract. Shared decoders
   live in `turbo/apps/api/src/lib/db-structured-result.ts`.
4. If the expression can return SQL `NULL`, wrap the column or decoder with
   `nullableDriverValueDecoder(...)`. Drizzle preserves `null` and applies the
   wrapped decoder only to non-null values.

```typescript
// Correct: LOWER(text) has the same driver representation as the text column.
const normalizedEmail = sql`LOWER(${users.email})`
  .mapWith(users.email)
  .as("normalized_email");

// Correct: the explicit decoder owns the runtime number contract.
const total = sql`COUNT(*)::int`.mapWith(pgIntegerDecoder).as("total");

// Correct: nullable SQL result with the column's non-null decoder.
const latestName = sql`MAX(${users.name})`
  .mapWith(nullableDriverValueDecoder(users.name))
  .as("latest_name");

// Incorrect: these only restate a TypeScript type.
const unsafeEmail = sql<string>`LOWER(${users.email})`;
const unsafeAlias = sql`LOWER(${users.email})`.as<string>("email");
```

Apply `.mapWith(...)` before `.as("alias")`; aliasing names a SQL field but does
not add or replace its decoder. A PostgreSQL cast such as `::int` changes the
server-side value representation, while `.mapWith(...)` defines the client-side
runtime decoder. A TypeScript assertion changes neither one.

The same rule applies to `db.query.<table>.findMany(...)` and
`findFirst(...)`, including callback-form `extras` and `extras` nested below
`with`. Keep relational configs inline or in inspectable local variables so
lint can follow every selected extra. Call `select`, `selectDistinct`,
`selectDistinctOn`, `returning`, `findMany`, and `findFirst` directly; do not
alias, destructure, or bind these methods, and do not spread their invocation
arguments, because those forms hide the result boundary from static
enforcement.

For set operations, every branch must expose a compatible, concretely mapped
output. Drizzle uses the leftmost branch's decoder for returned rows, so the
leftmost expression owns the runtime contract; mapping later branches does not
repair an unmapped leftmost branch.

PostgreSQL `int8` and `numeric` commonly arrive from `pg` as strings to avoid
precision loss. Use `pgInt8ToSafeIntegerDecoder` only when the value is required
to fit a JavaScript safe integer, and `pgInt8ToBigIntDecoder` when lossless
integer precision is required. Do not coerce arbitrary `numeric` values with
`Number` unless the domain contract explicitly permits the resulting precision;
use a dedicated decoder that preserves or validates the required representation.

Prefer schema-aware Drizzle builders and operators when they preserve the
intended SQL semantics. Use the `sql` tag or `SQL` type without a compile-time
result generic for constructs they cannot express cleanly. Compose dynamic SQL
from tagged `sql` fragments so interpolated values remain driver parameters;
`sql.raw(...)` bypasses parameter binding and is prohibited in API source except
for the local development seed script. Raw SQL used only as a predicate, join
condition, ordering or grouping expression, write value, discarded command, or
`rowCount` command result does not produce a structured field and needs no
result decoder. If a write query adds `.returning({...})`, map raw SQL in the
returned fields independently of `.set({...})`. Likewise, raw SQL passed to
`insert(...).select(...)` is the write source rather than a returned field; only
a subsequent `returning(...)` introduces a result-mapping boundary.

Use typed operators such as `eq`, `gt`, `isNull`, and `isNotNull` instead of an
equivalent SQL tag. They preserve the schema relationship between a column and
its bound value. Likewise, use `max(column)` or `min(column)` for the exact
aggregate form when the helper preserves the required decoder and nullability
contract. Keep an existing outer `.mapWith(...)` when it owns a stricter or more
specific contract than the helper's inferred result.

This preference also applies to a replaceable leaf inside otherwise irreducible
SQL. Interpolate the typed operator in place of that leaf while retaining the
outer tag for surrounding CTE, CASE, join, filter, cast, grouping, or statement
syntax. Do not replace outer composition with `and(...)` or `or(...)` when their
`SQL | undefined` result would weaken a required concrete `SQL` contract.
Keep SQL syntax that belongs to an operand inside that operand. For example,
write ``gte(events.createdAt, sql`${timestamp}::timestamp`)`` rather than
placing the cast after the interpolated `gte(...)` fragment.

Every remaining SQL-tag interpolation must have one unambiguous static role.
Do not interpolate `any`, `unknown`, a value that can be `undefined`, an array or
tuple directly, or a union that mixes an ordinary bound value with an SQL
wrapper. Narrow optional values before constructing SQL. Use `sql.empty()` for
an intentionally empty fragment, `sql.param(...)` when an array or other value
must be one driver parameter, and `sql.join(...)` when composing SQL fragments.
Keep bound values and SQL wrappers as distinct types across helper boundaries.

### Raw Execute Rows

Prefer structured Drizzle selections whenever they can express the query.
Direct `db.execute(...)` is allowed when rows are discarded or only `rowCount`
is consumed. When an irreducible raw query returns rows, use
`executeRawRows(executor, query, rowSchema)` from
`turbo/apps/api/src/lib/db-raw-rows.ts`:

```typescript
const rowSchema = z.object({
  id: z.string().uuid(),
  size_bytes: pgInt8ToSafeIntegerSchema,
});

const rows = await executeRawRows(
  db,
  sql`SELECT id, size_bytes FROM artifacts`,
  rowSchema,
);
```

`executeRawRows` executes without a row generic and parses every returned driver
row with the supplied schema; its TypeScript output is inferred from that schema.
Use schema transforms such as `pgInt8ToSafeIntegerSchema`,
`pgInt8ToBigIntSchema`, and `pgTimestampWithoutTimezoneToDateSchema` when the
driver representation differs from the application value. Never replace this
boundary with `execute<Row>`, a typed wrapper around `db.execute`, or a
downstream assertion.

## Checklist

Before committing:

- [ ] Schema file updated in `src/schema/`
- [ ] Schema exported in `src/index.ts` (if new table)
- [ ] Custom migrations created via `drizzle-kit generate --custom` (not manually)
- [ ] `pnpm db:migrate` works locally
- [ ] `pnpm test` passes
