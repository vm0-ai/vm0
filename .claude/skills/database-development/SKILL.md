---
name: database-development
description: Choose migration workflows or Drizzle runtime decoding and SQL construction rules
---

# Database Development

| Task                                     | Read                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Schema changes or data migration         | [Migration workflows](references/migrations.md) and [DB migrations](../../../turbo/packages/db/MIGRATIONS.md) |
| Selections, raw results, or SQL rewrites | [Query contracts](references/query-contracts.md)                                                              |
| Persisted shapes or deploy order         | [Deployment compatibility](../../../docs/deployment-compatibility.md)                                         |

Use Drizzle to generate migration metadata; do not hand-edit journals or
snapshots. Numbered external-data migration scripts are permanent historical
records, even after their referenced schema is retired. Keep them self-contained
and dry-run by default.

TypeScript generics do not decode PostgreSQL results. Use the first applicable
schema column, installed Drizzle helper, or reviewed runtime decoder; preserve
nullability, precision, and provenance. Query rewrites must preserve the whole
SQL contract, including bindings, transactions, locks, and material plan costs.
The query reference contains the complete decision order and examples.
