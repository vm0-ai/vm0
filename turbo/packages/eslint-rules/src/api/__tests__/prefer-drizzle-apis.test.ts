import { RuleTester } from "@typescript-eslint/rule-tester";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import { preferDrizzleApis } from "../rules/prefer-drizzle-apis.ts";
import { queryBuilderReadCases } from "./drizzle-query-builder-cases.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const dbPackageRoot = fileURLToPath(
  new URL("../../../../db/", import.meta.url),
);
const ruleTester = new RuleTester({
  defaultFilenames: {
    ts: `${dbPackageRoot}rule-test.ts`,
    tsx: `${dbPackageRoot}rule-test.tsx`,
  },
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ["rule-test.ts", "rule-test.tsx"],
      },
      tsconfigRootDir: dbPackageRoot,
    },
  },
});

const drizzlePreamble = `
  import { relations } from "drizzle-orm";
  import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

  const users = pgTable("users", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
    deletedAt: timestamp("deleted_at"),
    tags: jsonb("tags").$type<string[]>().notNull(),
  });
  const usersRelations = relations(users, () => ({}));
  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase<{
      users: typeof users;
      usersRelations: typeof usersRelations;
    }>;
  declare const db: DrizzleDatabase;
`;

const readQueryPreamble = `
  import { executeRawRows } from "./lib/db-raw-rows";
  import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

  const runs = pgTable("runs", {
    id: integer("id").notNull(),
    threadId: integer("thread_id").notNull(),
  });
  const runStates = pgTable("run_states", {
    id: integer("id").notNull(),
    status: text("status").notNull(),
  });
  const callbacks = pgTable("callbacks", {
    id: integer("id").notNull(),
    runId: integer("run_id").notNull(),
    payload: jsonb("payload").notNull(),
  });
  declare const db: never;
  declare const rowSchema: never;
  declare const threadId: number;
  declare const pageLimit: number;
`;

const structuredReadPreamble = `
  import { integer, pgTable, text } from "drizzle-orm/pg-core";

  const users = pgTable("users", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
  });
  const messages = pgTable("messages", {
    id: integer("id").notNull(),
    userId: integer("user_id").notNull(),
  });
  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase<{
      users: typeof users;
      messages: typeof messages;
    }>;
  declare const db: DrizzleDatabase;
`;

const structuredScalarQuery = `
  sql\`(
    SELECT "message"."id"
    FROM "messages" AS "message"
    WHERE "message"."user_id" = "users"."id"
    LIMIT 1
  )\`
`;

ruleTester.run("prefer-drizzle-apis", preferDrizzleApis, {
  valid: [
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const chooseLock: boolean;
        declare const rowSchema: never;
        const query = chooseLock
          ? sql\`
              SELECT \${users.id}
              FROM \${users}
              WHERE \${eq(users.id, 1)}
              FOR UPDATE
            \`
          : sql\`
              SELECT \${users.id}
              FROM \${users}
              WHERE \${eq(users.id, 1)}
              LIMIT 1
            \`;
        await executeRawRows(db, query, rowSchema);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { gte, sql } from "drizzle-orm";
        const value = 1;
        const condition = gte(users.id, 1);
        const fragment = sql\`\${users.id} + \${value}\`;
        sql\`SELECT \${users.id} FROM \${users} WHERE \${fragment}\`;
        sql\`\${users.id}::text = \${"1"}\`;
        sql\`LOWER(\${users.name}) = \${"name"}\`;
        sql\`LOWER(\${users.name}) IS NULL\`;
        sql\`\${users.id} IS DISTINCT FROM \${value}\`;
        sql\`UPDATE users SET \${users.id} = \${value}\`;
        sql\`1 + \${users.id} = \${value}\`;
        sql\`\${users.id} = \${value} + 1\`;
        sql\`\${gte(users.deletedAt, sql\`\${"2026-01-01"}::timestamp\`)}\`;
        sql\`MAX(\${users.id} + 1) FILTER (WHERE \${users.id} > 0)\`;
        sql\`MAX(\${users.id}) OVER (ORDER BY id)\`;
        sql\`COUNT(\${users.id}) FILTER (WHERE (\${condition})) OVER (ORDER BY id)\`;
        db.select({
          value: sql\`SUM(\${users.id} ORDER BY \${users.name})\`.mapWith(
            Number,
          ),
        }).from(users);
        db.select({
          value: sql\`SUM(VARIADIC \${users.tags})\`.mapWith(Number),
        }).from(users);
        sql\`MAX(\${fragment})\`;
        sql\`SUM(\${users.id})\`;
        sql\`COUNT(\${users.id})\`;
        sql\`COUNT(DISTINCT \${users.id})\`;
        sql\`AVG(\${users.id})\`;
        sql\`AVG(DISTINCT \${users.id})\`;
        sql\`SUM(DISTINCT \${users.id})\`;
        sql\`COUNT(*)\`;
        sql\`SELECT αcount(*), αsum(\${users.id}) FROM \${users}\`;
        sql\`\${users.id}\`;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select().from(users).where(sql\`\${users.id} =\`);
        db.select().from(users).crossJoin(users);
      `,
    },
    {
      code: `
        function sql(strings: TemplateStringsArray, ...values: unknown[]) {
          return { strings, values };
        }
        const left = 1;
        const right = 2;
        sql\`\${left} = \${right}\`;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const left = 1;
        const right = 2;
        sql\`\${left} = \${right}\`;
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`length(\${fields.name}) > 0\`,
        });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql, type SQL } from "drizzle-orm";
        const ids = [1, 2];
        const subquery = sql\`SELECT \${users.id} FROM \${users}\`;
        const arbitraryJoin = sql.join([subquery], sql\`, \`);
        const transformedList = sql.join(
          ids.map((id) => sql\`\${id + 1}\`),
          sql\`, \`,
        );
        let mutableList = sql.join(
          ids.map((id) => sql\`\${id}\`),
          sql\`, \`,
        );
        function listWithArgument(values: number[]) {
          return sql.join(
            values.map((value) => sql\`\${value}\`),
            sql\`, \`,
          );
        }
        function concrete(value: SQL): SQL {
          return value;
        }
        const condition = eq(users.id, 1);
        sql\`\${users.id} LIKE \${1}\`;
        sql\`\${users.id} IN (\${subquery})\`;
        sql\`\${users.id} IN (\${arbitraryJoin})\`;
        sql\`\${users.id} IN (\${transformedList})\`;
        sql\`\${users.id} IN (\${mutableList})\`;
        sql\`\${users.id} IN (\${listWithArgument(ids)})\`;
        sql\`\${users.id} NOT IN (\${mutableList})\`;
        sql\`SELECT \${users.id} DESC\`;
        sql\`ORDER BY \${users.id} DESCENDING\`;
        concrete(sql\`\${condition} AND \${condition}\`);
        sql\`\${users.name} @> \${sql\`jsonb_build_array('tag')\`}\`;
        sql\`\${condition} @> \${sql\`jsonb_build_array('tag')\`}\`;
        void mutableList;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, not, sql } from "drizzle-orm";
        const first = eq(users.id, 1);
        const second = eq(users.name, "name");
        db.select()
          .from(users)
          .where(not(sql\`\${first} AND \${second}\`));
        db.select({
          value: sql\`\${first} AND \${second}\`,
        }).from(users);
        db.select()
          .from(users)
          .groupBy(sql\`\${first} AND \${second}\`)
          .orderBy(sql\`\${first} AND \${second}\`);
        sql\`\${first} AND \${second}\`.mapWith(Boolean);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql as query } from "drizzle-orm";
        const names = ["one", "two"];
        const nameList = query.join(
          names.map((name) => query\`\${name}\`),
          query\`, \`,
        );
        const subquery = query\`SELECT \${users.name} FROM \${users}\`;
        function nameSqlList() {
          return query.join(
            names.map((name) => query\`\${name}\`),
            query\`, \`,
          );
        }
        const otherSql = {
          join(values: string[]) {
            return query.join(
              values.map((value) => query\`\${value}\`),
              query\`, \`,
            );
          },
        };
        function sql(strings: TemplateStringsArray, ...values: unknown[]) {
          return { strings, values };
        }
        sql.join = (values: unknown[], separator: unknown) => ({
          values,
          separator,
        });
        const condition = eq(users.id, 1);
        sql\`lower(\${users.name}) IN (\${sql.join(
          names.map((name) => sql\`\${name}\`),
          sql\`, \`,
        )})\`;
        query\`upper(\${users.name}) IN (\${query.join(
          names.map((name) => query\`\${name}\`),
          query\`, \`,
        )})\`;
        query\`lower(\${users.name}) NOT IN (\${query.join(
          names.map((name) => query\`\${name}\`),
          query\`, \`,
        )})\`;
        query\`lower(\${users.name}) IN (\${nameList})\`;
        query\`lower(\${users.name}) IN (\${nameSqlList()})\`;
        query\`lower(\${users.name}) IN (\${otherSql.join(names)})\`;
        query\`lower(\${users.name}) IN (\${subquery})\`;
        query\`lower(\${users.name}) IN (\${query.join(
          names.map((name) => query\`\${name.toUpperCase()}\`),
          query\`, \`,
        )})\`;
        query\`lower(\${users.name}) IN (\${query.join(
          names.map((name) => query\`\${name}\`),
          query\`; \`,
        )})\`;
        query\`SELECT lower(\${users.name}) IN (\${query.join(
          names.map((name) => query\`\${name}\`),
          query\`, \`,
        )}) FROM \${users}\`;
        query\`prefix_lower(\${users.name}) IN (\${query.join(
          names.map((name) => query\`\${name}\`),
          query\`, \`,
        )})\`;
        query\`lower(\${users.name}) IN (\${query.join(
          names.map((name) => query\`\${name}\`),
          query\`, \`,
        )}) IS TRUE\`;
        query\`lower(\${condition}) IN (\${query.join(
          names.map((name) => query\`\${name}\`),
          query\`, \`,
        )})\`;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { and, eq, isNotNull, or, sql } from "drizzle-orm";
        const selected = db
          .select({ id: users.id })
          .from(users)
          .as("selected_users");
        sql\` \`;
        sql\`true::boolean\`;
        db.select()
          .from(users)
          .leftJoinLateral(selected, sql\`true\`);
        db.select()
          .from(users)
          .leftJoinLateral(selected, sql\`true\`)
          .where(or(isNotNull(selected.id), eq(users.id, 1)));
        db.select()
          .from(users)
          .leftJoinLateral(selected, sql\`true\`)
          .where(
            and(or(isNotNull(selected.id), eq(users.id, 1)), eq(users.id, 2)),
          );
        db.select()
          .from(users)
          .leftJoinLateral(selected, sql\`true\`)
          .where(and(isNotNull(users.deletedAt), eq(users.id, 1)));
        db.select()
          .from(users)
          .innerJoinLateral(selected, eq(selected.id, users.id));
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        const selected = db
          .select({ id: users.id })
          .from(users)
          .as("selected_users");
        function isNotNull(value: unknown): SQL {
          return sql\`\${value}\`;
        }
        db.select()
          .from(users)
          .leftJoinLateral(selected, sql\`true\`)
          .where(isNotNull(selected.id));
      `,
    },
    {
      code: `
        function sql(strings: TemplateStringsArray, ...values: unknown[]) {
          return { strings, values };
        }
        const builder = {
          innerJoinLateral(relation: unknown, condition: unknown) {
            return { relation, condition };
          },
        };
        sql\`\`;
        builder.innerJoinLateral({}, sql\`true\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        import { alias } from "drizzle-orm/pg-core";
        const otherUsers = alias(users, "other_users");
        const condition = eq(users.id, 1);
        const rawRelation = sql\`jsonb_array_elements(\${users.tags}) AS item\`;
        sql\`EXISTS (SELECT 1 FROM \${rawRelation} WHERE \${condition})\`;
        sql\`EXISTS (SELECT 1 FROM \${users} AS u WHERE \${condition})\`;
        sql\`EXISTS (SELECT 1 FROM \${users} WHERE TRUE)\`;
        sql\`EXISTS (SELECT \${users.id} FROM \${users} WHERE \${condition})\`;
        sql\`EXISTS (SELECT 1 FROM \${users})\`;
        sql\`EXISTS (
          SELECT 1 FROM \${users}
          LEFT JOIN \${otherUsers} ON \${condition}
          WHERE \${condition}
        )\`;
        sql\`EXISTS (SELECT 1 FROM \${users} WHERE \${condition} OR \${condition})\`;
        sql\`EXISTS (SELECT 1 FROM \${users} WHERE \${condition} FOR UPDATE)\`;
        sql\`EXISTS (
          SELECT 1 FROM \${users}
          WHERE EXISTS (SELECT 1 FROM \${otherUsers} WHERE \${condition})
        )\`;
        sql\`SELECT EXISTS (SELECT 1 FROM \${users} WHERE \${condition})\`;
        sql\`NOT EXISTS (SELECT 1 FROM \${users} WHERE \${condition}) AND \${condition}\`;
        sql\`EXISTS (SELECT 1 FROM \${users} WHERE \${condition}); SELECT 1\`;
        sql\`WITH selected AS (SELECT 1) SELECT EXISTS (
          SELECT 1 FROM \${users} WHERE \${condition}
        )\`;
      `,
    },
    {
      code: `
        function sql(strings: TemplateStringsArray, ...values: unknown[]) {
          return { strings, values };
        }
        const table = { getSQL() {} };
        const predicate = { getSQL() {} };
        sql\`EXISTS (SELECT 1 FROM \${table} WHERE \${predicate})\`;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        const condition = eq(users.id, 1);
        const tagsSql = sql\`\${users.tags}\`;
        const qualifiedAggregate = sql.raw("pg_catalog.");
        sql\`\${users} LIKE \${"prefix%"}\`;
        sql\`\${users.name} NOT LIKE \${1}\`;
        sql\`\${users.id} BETWEEN \${1} OR \${2}\`;
        sql\`\${users.id} NOT BETWEEN \${1} OR \${2}\`;
        sql\`\${users.id} IS NOT \${condition}\`;
        sql\`1 NOT \${condition}\`;
        sql\`\${users.id} <@ \${tagsSql}\`;
        sql\`\${users.tags} && \${["one"]}\`;
        sql\`SELECT 'COUNT(*)', "COUNT(*)", $$COUNT(*)$$, $body$COUNT(*)$body$\`;
        sql\`SELECT /* COUNT(*) /* nested COUNT(*) */ */ 1 -- COUNT(*)
          FROM \${users}\`;
        sql\`COUNT(*) OVER (PARTITION BY \${users.id})\`;
        sql\`COUNT(*) FILTER (WHERE (\${condition})) OVER (ORDER BY \${users.id})\`;
        sql\`SELECT pg_catalog . count(*), pg_catalog.sum(\${users.id}) FROM \${users}\`;
        sql\`\${qualifiedAggregate} count(*)\`;
        sql\`\${qualifiedAggregate} sum(\${users.id})\`;
        sql\`'\${condition} NOT \${condition} COUNT(\${users.id})'\`;
        sql\`SELECT $body$\${condition} COUNT(*)$body$\`;
        sql\`SELECT /* \${condition} COUNT(*) */ 1\`;
        sql\`discount(*)\`;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql, type SQL } from "drizzle-orm";
        import { executeRawRows as decodeRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;

        const composed: SQL = sql\`
          SELECT \${users.id}
          FROM \${users}
          WHERE \${eq(users.id, 1)}
          LIMIT 1
        \`;
        declare function expose(value: SQL): void;
        expose(composed);
        await decodeRows(db, composed, rowSchema);
        await decodeRows(
          db,
          sql\`
            SELECT \${users.id}
            FROM \${users}
            WHERE \${eq(users.id, 1)}
            LIMIT 1;
            SELECT 1
          \`,
          rowSchema,
        );
        db.select().from(users).where(sql\`'\${users.id}' = 'literal'\`);
        db.select().from(users).where(sql\`\${1} = \${2}\`);
        db.select()
          .from(users)
          .where(
            sql\`__VM0_SQL_MARKER_0_0 = 1 AND '\${users.id}' = 'literal'\`,
          );

        function local(
          decodeRows: (...arguments_: unknown[]) => unknown,
        ): unknown {
          return decodeRows(
            db,
            sql\`
              SELECT \${users.id}
              FROM \${users}
              WHERE \${eq(users.id, 1)}
              LIMIT 1
            \`,
            rowSchema,
          );
        }
        void local;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "@fake/lib/db-raw-rows";
        declare const rowSchema: never;
        await executeRawRows(
          db,
          sql\`
            SELECT \${users.id}
            FROM \${users}
            WHERE \${eq(users.id, 1)}
            LIMIT 1
          \`,
          rowSchema,
        );
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const builder = {
          innerJoin(relation: unknown, condition: unknown) {
            return { relation, condition };
          },
        };
        builder.innerJoin(users, sql\`true\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare const flag: boolean;
        db.select()
          .from(users)
          .where(
            flag
              ? sql\`\${users.id} = \${1}\`
              : sql\`\${users.id} > \${1}\`,
          );
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql, type SQL } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        export const exportedQuery: SQL = sql\`
          SELECT \${users.id}
          FROM \${users}
          WHERE \${eq(users.id, 1)}
          LIMIT 1
        \`;
        await executeRawRows(db, exportedQuery, rowSchema);

        const mutatedQuery: SQL = sql\`
          SELECT \${users.id}
          FROM \${users}
          WHERE \${eq(users.id, 1)}
          LIMIT 1
        \`;
        mutatedQuery.append(sql.raw(""));
        await executeRawRows(db, mutatedQuery, rowSchema);

        const nestedSource: SQL = sql\`
          SELECT \${users.id}
          FROM \${users}
          WHERE \${eq(users.id, 1)}
          LIMIT 1
        \`;
        const escapedWrapper = sql\`\${nestedSource}\`;
        declare function expose(value: SQL): void;
        expose(escapedWrapper);
        await executeRawRows(db, nestedSource, rowSchema);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        const fake = {
          empty(): SQL {
            return sql\`true\`;
          },
          join(items: SQL[]): SQL {
            return items[0] ?? sql\`true\`;
          },
        };
        db.select().from(users).innerJoin(users, fake.empty());
        db.select()
          .from(users)
          .innerJoin(users, fake.join([sql\`true\`]));
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        function recursive(): SQL {
          return recursive();
        }
        db.select().from(users).innerJoin(users, recursive());
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare const flag: boolean;
        const condition =
          ${Array.from({ length: 17 }, () => "flag ? sql`true` : ").join("")}
          sql\`true\`;
        db.select().from(users).innerJoin(users, condition);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        const predicate0: SQL = sql\`true\`;
        ${Array.from({ length: 130 }, (_, index) => {
          return `const predicate${index + 1}: SQL = sql\`\${predicate${index}}\`;`;
        }).join("\n")}
        db.select().from(users).innerJoin(users, predicate130);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql, type SQL } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        function queryFor(table: typeof users): SQL {
          return sql\`
            SELECT \${table.id}
            FROM \${table}
            WHERE \${eq(table.id, 1)}
            LIMIT 1
          \`;
        }
        await executeRawRows(db, queryFor(users), rowSchema);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare const flag: boolean;
        const predicates = [sql\`true\`];
        db.select()
          .from(users)
          .innerJoin(
            users,
            sql.join(
              [...predicates],
              sql\` AND \`,
            ),
          );
        db.select()
          .from(users)
          .innerJoin(
            users,
            sql.join(
              predicates.map((predicate) => predicate),
              sql\` AND \`,
            ),
          );
        db.select()
          .from(users)
          .innerJoin(users, flag ? sql.empty() : sql\`true\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const column = sql\`\${users.id}\`;
        db.select()
          .from(users)
          .where(sql\`COALESCE(\${column} = \${1}, FALSE)\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const statement = sql\`
          DELETE FROM \${users}
          WHERE \${users.id} = \${1}
        \`;
        await db.execute(statement);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        import { alias } from "drizzle-orm/pg-core";
        const otherUsers = alias(users, "other_users");
        const relation = sql\`
          \${users}
          INNER JOIN \${otherUsers} ON \${users.id} = \${otherUsers.id}
        \`;
        db.select().from(relation);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const selection = sql\`\${users.id} = \${1} AS matched\`;
        db.select({ matched: selection }).from(users);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const predicate = sql\`
          \${users.id} = \${1}
          ORDER BY \${users.id}
        \`;
        db.select().from(users).where(predicate);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const ordering = sql\`\${users.id} DESC LIMIT 1\`;
        db.select().from(users).orderBy(ordering);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select()
          .from(users)
          .innerJoin(users, sql\`true ORDER BY \${users.id}\`);
      `,
    },
  ],
  invalid: [
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const chooseFirst: boolean;
        declare const rowSchema: never;
        const query = chooseFirst
          ? sql\`
              SELECT \${users.id}
              FROM \${users}
              WHERE \${eq(users.id, 1)}
              LIMIT 1
            \`
          : sql\`
              SELECT \${users.id}
              FROM \${users}
              WHERE \${eq(users.id, 2)}
              LIMIT 1
            \`;
        await executeRawRows(db, query, rowSchema);
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${structuredReadPreamble}
        import { eq, sql } from "drizzle-orm";
        db.select({
          value: sql\`(
            SELECT \${messages.id}
            FROM \${messages}
            WHERE \${eq(messages.userId, users.id)}
            LIMIT 1
          )\`.mapWith(messages.id),
        });
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${readQueryPreamble}
        import { desc, eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            SELECT
              \${runs.id} AS "runId",
              COALESCE(\${runStates.status}, 'unknown') AS "status"
            FROM \${runs}
            INNER JOIN \${runStates}
              ON \${eq(runStates.id, runs.id)}
            LEFT JOIN \${callbacks}
              ON \${eq(callbacks.runId, runs.id)}
            WHERE \${eq(runs.threadId, threadId)}
            ORDER BY \${desc(runs.id)}
            LIMIT \${pageLimit}
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${readQueryPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            SELECT EXISTS (
              SELECT 1
              FROM \${runs}
              INNER JOIN \${runStates}
                ON \${eq(runStates.id, runs.id)}
              WHERE \${eq(runs.threadId, threadId)}
              LIMIT 1
            ) AS visible
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "existsQueryBuilder" }],
    },
    {
      code: `${readQueryPreamble}
        import { eq, sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            SELECT
              \${runs.id} AS "runId",
              \${runs.threadId} > 0 AS "isExpired"
            FROM \${runs}
            WHERE \${eq(runs.id, threadId)}
            FOR UPDATE
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "lockingQueryBuilder" }],
    },
    {
      code: `${readQueryPreamble}
        import { sql } from "drizzle-orm";
        await executeRawRows(
          db,
          sql\`
            WITH org AS (
              SELECT credits
              FROM org_metadata
              WHERE org_id = \${threadId}
              LIMIT 1
            ),
            expired AS (
              SELECT COALESCE(SUM(remaining), 0)::bigint AS total
              FROM credit_expires_record
              WHERE org_id = \${threadId}
                AND remaining > 0
            )
            SELECT
              (SELECT credits FROM org) AS credits,
              (SELECT total FROM expired) AS expired
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "scalarCteQueryBuilder" }],
    },
    {
      code: `${readQueryPreamble}
        import { sql } from "drizzle-orm";
        function rowsWith(userId: number) {
          return sql\`
            WITH rows AS (
              SELECT event_id
              FROM usage_events ue
              WHERE ue.user_id = \${userId}
            )
          \`;
        }
        await executeRawRows(
          db,
          sql\`
            \${rowsWith(threadId)}
            SELECT r.event_id
            FROM rows r
            ORDER BY r.event_id
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "composedCteQueryBuilder" }],
    },
    {
      code: `${structuredReadPreamble}
        import { sql } from "drizzle-orm";
        db.select({ value: ${structuredScalarQuery} }).from(users);
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql, type SQL } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        const query: SQL = sql\`
          SELECT \${users.id}
          FROM \${users}
          WHERE \${eq(users.id, 1)}
          LIMIT 1
        \`;
        await executeRawRows(db, query, rowSchema);
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select()
          .from(users)
          .where(sql\`\${sql\`\${users.id} = \${1}\`}\`);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "eq" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const column = sql\`\${users.id}\`;
        db.select().from(users).where(sql\`\${column} = \${1}\`);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "eq" },
          line: 21,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const predicate = sql\`\${users.id} = \${1}\`;
        db.select()
          .from(users)
          .where(sql\`unsupported('α', \${predicate})\`);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "eq" },
          line: 23,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const predicate = sql\`\${users.id} = \${1}\`;
        db.select()
          .from(users)
          .where(sql\`unsupported(\${predicate}, \${predicate})\`);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "eq" },
          line: 23,
        },
        {
          messageId: "typedApi",
          data: { helper: "eq" },
          line: 23,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        db.select()
          .from(users)
          .where(
            sql\`COALESCE(\${sql.join(
              [eq(users.id, 1), eq(users.name, "name")],
              sql\` AND \`,
            )}, FALSE)\`,
          );
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 23,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql, type SQL } from "drizzle-orm";
        function conjunction(left: SQL, right: SQL): SQL {
          return sql\`\${left} AND \${right}\`;
        }
        db.select()
          .from(users)
          .where(
            sql\`COALESCE(\${conjunction(
              eq(users.id, 1),
              eq(users.name, "name"),
            )}, FALSE)\`,
          );
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 26,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const fragment = sql\`
          \${users.id} = \${1}
          AND \${users.name} = \${"name"}
        \`;
        db.select()
          .from(users)
          .where(sql\`EXISTS (SELECT 1 WHERE \${fragment})\`);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 26,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        const predicate = sql.join(
          [eq(users.id, 1), eq(users.name, "name")],
          sql\` AND \`,
        );
        db.select().from(users).where(sql\`unsupported(\${predicate})\`);
        db.select().from(users).having(sql\`NOT \${predicate}\`);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 24,
        },
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 25,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        const fragment = sql\`\${users.deletedAt} IS NOT NULL\`;
        db.select()
          .from(users)
          .where(sql\`\${fragment} AND \${eq(users.id, 1)}\`);
        db.select()
          .from(users)
          .having(sql\`COALESCE(\${fragment}, FALSE)\`);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
        },
        {
          messageId: "typedApi",
          data: { helper: "isNotNull" },
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const fragment = sql\`
          \${users.id} = \${1}
          AND \${users.name} = \${"name"}
        \`;
        db.select().from(users).where(sql\`unsupported(\${fragment})\`);
        db.select().from(users).having(sql\`NOT \${fragment}\`);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 24,
        },
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 25,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const fragment = sql\`
          \${users.id} = \${1}
          AND \${users.name} = \${"name"}
        \`;
        db.select().from(users).where(sql\`NOT \${fragment}\`);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 24,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const fragment = sql\`
          \${users.id} = \${1}
          OR \${users.name} = \${"name"}
        \`;
        db.select()
          .from(users)
          .where(
            sql\`(\${fragment}) AND \${users.deletedAt} IS NOT NULL\`,
          );
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 27,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const fragment = sql\`
          \${users.id} = \${1}
          OR \${users.name} = \${"name"}
        \`;
        db.select()
          .from(users)
          .where(
            sql\`\${fragment} AND \${users.deletedAt} IS NOT NULL\`,
          );
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "or" },
          line: 27,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const fragment = sql\`
          \${users.id} = \${1}
          AND \${users.name} = \${"name"}
        \`;
        db.select().from(users).where(sql\` \${fragment} \`);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 24,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const predicate = sql\`\${users.id} = \${1}\`;
        db.select().from(users).where(predicate).having(predicate);
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "eq" },
          line: 21,
        },
        {
          messageId: "typedApi",
          data: { helper: "eq" },
          line: 21,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const predicate = sql\`\${users.id} = \${1}\`;
        db.select()
          .from(users)
          .where(sql\`\${sql.empty()}\${predicate}\`);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "eq" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const predicates = [
          sql\`\${users.id} = \${1}\`,
          sql\`\${users.name} = \${"name"}\`,
        ];
        db.select()
          .from(users)
          .where(sql.join(predicates, sql\` AND \`));
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 26,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        db.select()
          .from(users)
          .where(
            drizzle.sql.join(
              [
                drizzle.sql\`\${users.id} = \${1}\`,
                drizzle.sql\`\${users.name} = \${"name"}\`,
              ],
              drizzle.sql\` AND \`,
            ),
          );
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 23,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        function comparison(
          column: typeof users.id,
          value: number,
        ): SQL {
          return sql\`\${column} = \${value}\`;
        }
        db.select().from(users).where(comparison(users.id, 1));
        db.select().from(users).having(comparison(users.id, 2));
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "eq" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        function conjunction(left: SQL, right: SQL): SQL {
          return sql\`\${left} AND \${right}\`;
        }
        db.select()
          .from(users)
          .where(
            conjunction(
              sql\`\${users.id} = \${1}\`,
              sql\`\${users.name} = \${"one"}\`,
            ),
          );
        db.select()
          .from(users)
          .having(
            conjunction(
              sql\`\${users.id} = \${2}\`,
              sql\`\${users.name} = \${"two"}\`,
            ),
          );
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 26,
        },
        {
          messageId: "typedApi",
          data: { helper: "and" },
          line: 34,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        declare const flag: boolean;
        function choose(left: SQL, right: SQL): SQL {
          return flag ? left : right;
        }
        db.select()
          .from(users)
          .where(
            choose(
              sql\`\${users.id} = \${1}\`,
              sql\`\${users.name} = \${"name"}\`,
            ),
          );
      `,
      errors: [
        {
          messageId: "typedApi",
          data: { helper: "eq" },
          line: 27,
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare const flag: boolean;
        db.select()
          .from(users)
          .where(
            flag
              ? sql\`\${users.id} = \${1}\`
              : sql\`\${users.name} = \${"name"}\`,
          );
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "eq" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare const flag: boolean;
        db.select()
          .from(users)
          .where(
            flag
              ? sql\`\${users.id} = \${1} AND \${users.name} = \${"one"}\`
              : sql\`\${users.id} = \${2} AND \${users.name} = \${"two"}\`,
          );
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "and" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        await executeRawRows(
          db,
          sql\`
            SELECT \${users.id} AS "id"
            FROM \${users}
            WHERE \${eq(users.id, 1)}
            LIMIT 1
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        await executeRawRows(
          db,
          sql\`
            SELECT \${users.id}
            FROM \${users}
            WHERE \${users.deletedAt} IS NULL
            LIMIT 1
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql as query } from "drizzle-orm";
        import { executeRawRows as decodeRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        await decodeRows(
          db,
          query\`select \${users.id} from \${users} where \${eq(users.id, 1)} limit 1;\`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        import * as rawRows from "./lib/db-raw-rows";
        declare const rowSchema: never;
        await rawRows.executeRawRows(
          db,
          drizzle.sql\`
            SELECT \${users.id}
            FROM \${users}
            WHERE \${drizzle.eq(users.id, 1)}
              AND $$ORDER BY ignored$$ = $$ORDER BY ignored$$
              /* GROUP BY ignored /* nested ORDER BY */ */
            LIMIT 1
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        await executeRawRows(
          db,
          sql\`
            /* __vm0_sql_marker_0_ and Unicode α */
            SELECT \${users.id} AS "识别符"
            FROM \${users}
            WHERE \${eq(users.id, 1)}
            LIMIT 1
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        await executeRawRows(
          db,
          sql\`
            SELECT \${users.id}
            FROM \${users}
            WHERE \${users.id} = \${1}
            ORDER BY \${users.id}
            LIMIT 1
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "typedApi", data: { helper: "eq" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select()
          .from(users)
          .where(sql\`\${users.deletedAt} IS NULL\`);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "isNull" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        await executeRawRows(
          db,
          sql\`
            SELECT \${users.id}
            FROM \${users}
            WHERE \${users.deletedAt} IS NULL
            ORDER BY \${users.id}
          \`,
          rowSchema,
        );
      `,
      errors: [{ messageId: "typedApi", data: { helper: "isNull" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select()
          .from(users)
          .where(sql\`\${users.deletedAt} > now()\`);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "gt" } }],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        const condition = eq(users.id, 1);
        db.select()
          .from(users)
          .where(sql\`\${condition} AND unsupported(\${users.name})\`);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "and" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select()
          .from(users)
          .where(
            sql\`(\${users.id} = \${1} OR unsupported(\${users.name}))
              AND \${users.id} > \${2}\`,
          );
      `,
      errors: [{ messageId: "typedApi", data: { helper: "and" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select()
          .from(users)
          .where(sql\`unsupported(\${users.id} = \${1})\`);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "eq" } }],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: never;
        await executeRawRows(
          db,
          sql\`
            WITH first_group AS (
              SELECT 1
              WHERE \${eq(users.id, 1)} AND \${eq(users.name, "one")}
            ),
            second_group AS (
              SELECT 1
              WHERE \${eq(users.id, 2)} AND \${eq(users.name, "two")}
            )
            SELECT 1
          \`,
          rowSchema,
        );
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "and" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select()
          .from(users)
          .innerJoin(users, sql\`/* structural */ TRUE\`);
      `,
      errors: [{ messageId: "crossJoin" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        sql\`\`;
      `,
      errors: [{ messageId: "emptyFragment" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql as query } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        query\`\`;
        drizzle.sql\`\`;
        const tag = drizzle.sql;
        tag\`\`;
      `,
      errors: [
        { messageId: "emptyFragment" },
        { messageId: "emptyFragment" },
        { messageId: "emptyFragment" },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const names = ["one", "two"];
        db.select()
          .from(users)
          .where(
            sql\`lower(\${users.name}) IN (\${sql.join(
              names.map((name) => {
                return sql\`\${name}\`;
              }),
              sql\`, \`,
            )})\`,
          );
      `,
      errors: [{ messageId: "typedApi", data: { helper: "inArray" } }],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql as query } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        const condition = eq(users.id, 1);
        const nameSql = query\`\${users.name}\`.mapWith(users.name);
        const aliasedNameSql = nameSql.as("aliased_name");
        const selected = db.select({ id: users.id }).from(users);
        const tag = drizzle.sql;
        db.select().from(users).where(query\`NOT \${condition}\`);
        db.select()
          .from(users)
          .where(drizzle.sql\`unsupported(NOT \${condition})\`);
        db.select()
          .from(users)
          .where(tag\`\${users.name} NOT LIKE \${"prefix%"} ESCAPE '\\\\'\`);
        db.select()
          .from(users)
          .where(query\`\${users.name} ILIKE \${"prefix%"}\`);
        db.select()
          .from(users)
          .where(
            drizzle.sql\`\${users.name} NOT ILIKE \${query\`LOWER(\${"prefix%"})\`}\`,
          );
        db.select()
          .from(users)
          .where(tag\`\${nameSql} ILIKE \${"prefix%"}\`);
        db.select()
          .from(users)
          .where(query\`\${aliasedNameSql} NOT LIKE \${"prefix%"}\`);
        db.select()
          .from(users)
          .where(tag\`\${users.id} BETWEEN \${1} AND \${2}\`);
        db.select()
          .from(users)
          .where(
            tag\`\${users.deletedAt} BETWEEN \${"2026-01-01"}::timestamp AND \${"2026-01-02"}::timestamp\`,
          );
        db.select()
          .from(users)
          .where(query\`\${users.id} NOT BETWEEN \${1} AND \${2}\`);
        db.select()
          .from(users)
          .where(drizzle.sql\`EXISTS \${selected}\`);
        db.select().from(users).where(tag\`NOT EXISTS \${selected}\`);
        function pattern<T extends typeof users.name>(left: T) {
          return query\`\${left} NOT ILIKE \${"prefix%"}\`;
        }
        db.select().from(users).where(pattern(users.name));
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "not" } },
        { messageId: "typedApi", data: { helper: "not" } },
        { messageId: "typedApi", data: { helper: "notLike" } },
        { messageId: "typedApi", data: { helper: "ilike" } },
        { messageId: "typedApi", data: { helper: "notIlike" } },
        { messageId: "typedApi", data: { helper: "ilike" } },
        { messageId: "typedApi", data: { helper: "notLike" } },
        { messageId: "typedApi", data: { helper: "between" } },
        { messageId: "typedApi", data: { helper: "between" } },
        { messageId: "typedApi", data: { helper: "notBetween" } },
        { messageId: "typedApi", data: { helper: "exists" } },
        { messageId: "typedApi", data: { helper: "notExists" } },
        { messageId: "typedApi", data: { helper: "notIlike" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
        const tagsSql = sql\`\${users.tags}\`;
        const typedTagsSql = sql\`\${users.tags}\`.mapWith(users.tags);
        const aliasedTagsSql = typedTagsSql.as("aliased_tags");
        db.select()
          .from(users)
          .where(sql\`\${users.tags} <@ \${tagsSql}\`);
        db.select()
          .from(users)
          .where(sql\`\${users.tags} && \${tagsSql}\`);
        db.select()
          .from(users)
          .where(sql\`\${typedTagsSql} @> \${tagsSql}\`);
        db.select()
          .from(users)
          .where(sql\`\${aliasedTagsSql} <@ \${tagsSql}\`);
        function overlaps<T extends typeof users.tags>(left: T, right: SQLWrapper) {
          return sql\`\${left} && \${right}\`;
        }
        function overlapsSql<T extends SQL<string[]>>(left: T, right: SQLWrapper) {
          return sql\`\${left} && \${right}\`;
        }
        db.select().from(users).where(overlaps(users.tags, tagsSql));
        db.select().from(users).where(overlapsSql(typedTagsSql, tagsSql));
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "arrayContained" } },
        { messageId: "typedApi", data: { helper: "arrayOverlaps" } },
        { messageId: "typedApi", data: { helper: "arrayContains" } },
        { messageId: "typedApi", data: { helper: "arrayContained" } },
        { messageId: "typedApi", data: { helper: "arrayOverlaps" } },
        { messageId: "typedApi", data: { helper: "arrayOverlaps" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql } from "drizzle-orm";
        const condition = eq(users.id, 1);
        await db.execute(
          sql\`SELECT COUNT(*)::int, COUNT(*) FILTER (WHERE \${condition}) FROM \${users}\`,
        );
        await db.execute(sql\`SELECT SUM(\${users.id}) FROM \${users}\`);
        await db.execute(sql\`SELECT COUNT(\${users.id}) FROM \${users}\`);
        await db.execute(
          sql\`SELECT COUNT(DISTINCT \${users.id}) FROM \${users}\`,
        );
        await db.execute(sql\`SELECT AVG(\${users.id}) FROM \${users}\`);
        await db.execute(
          sql\`SELECT AVG(DISTINCT \${users.id}) FROM \${users}\`,
        );
        await db.execute(
          sql\`SELECT SUM(DISTINCT \${users.id}) FROM \${users}\`,
        );
        await db.execute(sql\`SELECT MIN(\${users.id}) FROM \${users}\`);
        const fragment = sql\`\${users.id} + 1\`;
        sql\`COUNT(*)\`.mapWith(Number);
        sql\`SUM(\${fragment})\`.mapWith(users.id);
        sql\`MAX(\${fragment})\`.mapWith(users.id);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "count" } },
        { messageId: "typedApi", data: { helper: "count" } },
        { messageId: "typedApi", data: { helper: "sum" } },
        { messageId: "typedApi", data: { helper: "count" } },
        { messageId: "typedApi", data: { helper: "countDistinct" } },
        { messageId: "typedApi", data: { helper: "avg" } },
        { messageId: "typedApi", data: { helper: "avgDistinct" } },
        { messageId: "typedApi", data: { helper: "sumDistinct" } },
        { messageId: "typedApi", data: { helper: "min" } },
        { messageId: "typedApi", data: { helper: "count" } },
        { messageId: "typedApi", data: { helper: "sum" } },
        { messageId: "typedApi", data: { helper: "max" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select({
          value: sql\`SUM(
            \${users.id}
            ORDER BY \${users.name} DESC
          )\`.mapWith(Number),
        }).from(users);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "desc" } }],
    },
    {
      code: `${drizzlePreamble}
        import { and, eq, isNotNull, sql } from "drizzle-orm";
        db.select()
          .from(users)
          .where(
            sql\`EXISTS (
              SELECT 1
              FROM \${users}
              WHERE \${eq(users.id, 1)}
                AND \${isNotNull(users.name)}
            )\`,
          );
      `,
      errors: [
        {
          messageId: "existencePredicate",
          data: { helper: "exists" },
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { eq, isNotNull, sql as query } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        import { alias } from "drizzle-orm/pg-core";
        const otherUsers = alias(users, "other_users");
        const tag = drizzle.sql;
        db.select()
          .from(users)
          .where(
            query\` not   exists(
              select 1 from \${users}
              inner join \${otherUsers} on \${eq(otherUsers.id, users.id)}
              where \${eq(users.id, 1)} and \${isNotNull(otherUsers.name)}
              limit 1
            ) \`,
          );
        db.select()
          .from(users)
          .where(
            drizzle.sql\`EXISTS (SELECT 1 FROM \${otherUsers} WHERE \${eq(otherUsers.id, 1)})\`,
          );
        db.select()
          .from(users)
          .where(
            tag\`NOT EXISTS (SELECT 1 FROM \${users} WHERE \${eq(users.id, 1)})\`,
          );
      `,
      errors: [
        {
          messageId: "existencePredicate",
          data: { helper: "notExists" },
        },
        {
          messageId: "existencePredicate",
          data: { helper: "exists" },
        },
        {
          messageId: "existencePredicate",
          data: { helper: "notExists" },
        },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select()
          .from(users)
          .where(
            sql\`EXISTS (SELECT 1 FROM \${users} WHERE \${users.id} = \${1})\`,
          );
      `,
      errors: [{ messageId: "typedApi", data: { helper: "eq" } }],
    },
    {
      code: `${drizzlePreamble}
        import { isNotNull, sql } from "drizzle-orm";
        const selected = db
          .select({ id: users.id })
          .from(users)
          .as("selected_users");
        db.select()
          .from(users)
          .innerJoinLateral(selected, sql\`true\`);
        db.select()
          .from(users)
          .leftJoinLateral(selected, sql\`true\`)
          .where(isNotNull(selected.id));
      `,
      errors: [
        { messageId: "crossJoinLateral" },
        { messageId: "crossJoinLateral" },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql as query } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        const selected = db
          .select({ id: users.id })
          .from(users)
          .as("selected_users");
        const trueCondition = query\`true\`;
        db.select()
          .from(users)
          .innerJoinLateral(selected, query\` true \`);
        db.select()
          .from(users)
          .innerJoinLateral(selected, drizzle.sql\`TRUE\`);
        db.select()
          .from(users)
          .innerJoinLateral(selected, trueCondition);
      `,
      errors: [
        { messageId: "crossJoinLateral" },
        { messageId: "crossJoinLateral" },
        { messageId: "crossJoinLateral" },
      ],
    },
    {
      code: `${drizzlePreamble}
        import {
          and as all,
          eq,
          isNotNull as present,
          sql as query,
        } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        const selected = db
          .select({ id: users.id })
          .from(users)
          .as("selected_users");
        db.select()
          .from(users)
          .leftJoinLateral(selected, query\`true\`)
          .where(present(selected.id));
        db.select()
          .from(users)
          .leftJoinLateral(selected, drizzle.sql\` TRUE \`)
          .where(all(eq(users.id, 1), drizzle.isNotNull(selected.id)));
      `,
      errors: [
        { messageId: "crossJoinLateral" },
        { messageId: "crossJoinLateral" },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const value = 1;
        db.select().from(users).where(sql\`\${users.id} = \${value}\`);
        db.select().from(users).where(sql\`\${users.id} <> \${value}\`);
        db.select().from(users).where(sql\`\${users.id} > \${value}\`);
        db.select().from(users).where(sql\`\${users.id} >= \${value}\`);
        db.select().from(users).where(sql\`\${users.id} < \${value}\`);
        db.select().from(users).where(sql\`\${users.id} <= \${value}\`);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "ne" } },
        { messageId: "typedApi", data: { helper: "gt" } },
        { messageId: "typedApi", data: { helper: "gte" } },
        { messageId: "typedApi", data: { helper: "lt" } },
        { messageId: "typedApi", data: { helper: "lte" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql as query } from "drizzle-orm";
        db.select()
          .from(users)
          .where(query\` \${users.deletedAt}  is   null \`);
        db.select()
          .from(users)
          .where(query\`\${users.deletedAt}\nIS NOT NULL\`);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "isNull" } },
        { messageId: "typedApi", data: { helper: "isNotNull" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        db.select({ value: drizzle.sql\`MAX ( \${users.id} )\` }).from(users);
        const query = drizzle.sql;
        db.select({ value: query\`min(\${users.id})\` }).from(users);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "max" } },
        { messageId: "typedApi", data: { helper: "min" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const selected = db
          .select({ id: users.id })
          .from(users)
          .as("selected_users");
        db.select()
          .from(users)
          .where(sql\`\${selected.id} > \${users.id}\`);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "gt" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const value = 1;
        db.select().from(users).where(sql\`(\${users.id} = \${value})\`);
        db.select()
          .from(users)
          .where(sql\`\${users.deletedAt} >= \${"2026-01-01"}::timestamp\`);
        await db.execute(
          sql\`SELECT 1
            WHERE \${users.deletedAt} < \${"2026-01-02"}::timestamptz
              AT TIME ZONE 'UTC'
            ORDER BY 1\`,
        );
        await db.execute(
          sql\`
            SELECT \${users.id}
            FROM \${users}
            WHERE \${users.id} >= \${value}
              AND \${users.deletedAt} IS NOT NULL
          \`,
        );
        db.select({
          value: sql\`CASE
            WHEN \${users.id} > \${value} AND \${users.id} <> \${value}
            THEN \${users.name}
            ELSE NULL
          END\`,
        }).from(users);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "gte" } },
        { messageId: "typedApi", data: { helper: "lt" } },
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "and" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`(\${fields.id} > \${0}) OR \${fields.deletedAt} IS NULL\`,
        });
      `,
      errors: [{ messageId: "typedApi", data: { helper: "or" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQLWrapper } from "drizzle-orm";
        function comparison<T extends SQLWrapper>(left: T, right: string) {
          return sql\`\${left} = \${right}\`;
        }
        function present<T extends SQLWrapper>(value: T) {
          return sql\`\${value} IS NOT NULL\`;
        }
        function aggregate<T extends typeof users.id>(column: T) {
          return sql\`MAX(\${column})\`;
        }
        db.select().from(users).where(comparison(users.id, "1"));
        db.select().from(users).where(present(users.id));
        db.select({ value: aggregate(users.id) }).from(users);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "isNotNull" } },
        { messageId: "typedApi", data: { helper: "max" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql, type SQL } from "drizzle-orm";
        const names = ["one", "two"];
        const nameList = sql.join(
          names.map((name) => sql\`\${name}\`),
          sql\`, \`,
        );
        function nameSqlList() {
          return sql.join(
            names.map((name) => sql\`\${name}\`),
            sql\`, \`,
          );
        }
        function optional(value: SQL): SQL {
          return value;
        }
        const condition = eq(users.id, 1);
        const jsonArray = sql\`jsonb_build_array(\${"tag"})\`;
        db.select()
          .from(users)
          .where(sql\`\${users.name} LIKE \${"prefix%"} ESCAPE '\\\\'\`);
        db.select()
          .from(users)
          .where(sql\`\${users.name} IN (\${nameList})\`);
        db.select()
          .from(users)
          .where(sql\`\${users.name} IN (\${nameSqlList()})\`);
        db.select()
          .from(users)
          .where(sql\`\${users.name} NOT IN (\${nameList})\`);
        db.select()
          .from(users)
          .where(sql\`\${users.name} NOT IN (\${nameSqlList()})\`);
        db.select()
          .from(users)
          .orderBy(
            sql\`\${users.name} ASC\`,
            sql\`\${users.id} DESC NULLS FIRST\`,
          );
        db.select({
          value: sql\`COALESCE(SUM(\${users.id}), 0)\`,
        }).from(users);
        db.select({
          value: sql\`COUNT(\${users.id}) FILTER (WHERE \${condition})::int\`,
        }).from(users);
        db.select({
          value: sql\`MAX(\${users.deletedAt}) FILTER (WHERE \${condition})\`,
        }).from(users);
        await db.execute(
          sql\`SELECT COUNT(\${users.id}), COUNT(DISTINCT \${users.name}), MAX(\${users.id}) FROM \${users}\`,
        );
        db.select()
          .from(users)
          .where(optional(sql\`(\${condition} AND \${condition}) OR \${condition}\`));
        db.select()
          .from(users)
          .where(sql\`\${users.tags} @> \${jsonArray}\`);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "like" } },
        { messageId: "typedApi", data: { helper: "inArray" } },
        { messageId: "typedApi", data: { helper: "inArray" } },
        { messageId: "typedApi", data: { helper: "notInArray" } },
        { messageId: "typedApi", data: { helper: "notInArray" } },
        { messageId: "typedApi", data: { helper: "asc" } },
        { messageId: "typedApi", data: { helper: "desc" } },
        { messageId: "typedApi", data: { helper: "sum" } },
        { messageId: "typedApi", data: { helper: "count" } },
        { messageId: "typedApi", data: { helper: "max" } },
        { messageId: "typedApi", data: { helper: "count" } },
        { messageId: "typedApi", data: { helper: "countDistinct" } },
        { messageId: "typedApi", data: { helper: "max" } },
        { messageId: "typedApi", data: { helper: "or" } },
        { messageId: "typedApi", data: { helper: "arrayContains" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { eq, sql as query } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        const names = ["one", "two"];
        const condition = eq(users.id, 1);
        const tag = drizzle.sql;
        db.select()
          .from(users)
          .where(
            query\`lower(\${users.name}) IN (\${query.join(
              names.map((name) => query\`\${name}\`),
              query\`, \`,
            )})\`,
          );
        db.select()
          .from(users)
          .where(
            drizzle.sql\`LOWER (\${users.name}) in (\${drizzle.sql.join(
              names.map((name) => drizzle.sql\`\${name}\`),
              drizzle.sql\`, \`,
            )}) AND \${condition}\`,
          );
        db.select()
          .from(users)
          .where(
            tag\`NOT lower(\${users.name}) IN (\${tag.join(
              names.map((name) => tag\`\${name}\`),
              tag\`, \`,
            )})\`,
          );
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "inArray" } },
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "not" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql as query, type SQLWrapper } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        const names = ["one", "two"];
        const nameList = drizzle.sql.join(
          names.map((name) => drizzle.sql\`\${name}\`),
          drizzle.sql\`, \`,
        );
        db.select()
          .from(users)
          .where(query\`\${users.name} LIKE \${"prefix%"}\`);
        db.select()
          .from(users)
          .where(drizzle.sql\`\${users.name} IN (\${nameList})\`);
        db.select()
          .from(users)
          .orderBy(
            drizzle.sql\`\${users.name} ASC\`,
            drizzle.sql\`COALESCE(SUM(\${users.id}), 0)\`,
          );
        function contains<T extends typeof users.tags>(column: T, value: SQLWrapper) {
          return query\`\${column} @> \${value}\`;
        }
        db.select()
          .from(users)
          .where(
            contains(users.tags, drizzle.sql\`\${users.tags}\`),
          );
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "like" } },
        { messageId: "typedApi", data: { helper: "inArray" } },
        { messageId: "typedApi", data: { helper: "asc" } },
        { messageId: "typedApi", data: { helper: "sum" } },
        { messageId: "typedApi", data: { helper: "arrayContains" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`\${fields.name} LIKE \${"prefix%"}\`,
        });
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`\${operators.eq(fields.id, 1)} AND \${operators.isNotNull(fields.name)}\`,
        });
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`NOT \${operators.eq(fields.id, 1)}\`,
        });
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`\${fields.name} ILIKE \${"prefix%"}\`,
        });
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`\${fields.id} BETWEEN \${1} AND \${2}\`,
        });
        db.query.users.findMany({
          where: (fields, operators) => {
            return operators.sql\`\${operators.eq(fields.id, 1)} AND \${operators.isNotNull(fields.name)}\`;
          },
        });
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "like" } },
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "not" } },
        { messageId: "typedApi", data: { helper: "ilike" } },
        { messageId: "typedApi", data: { helper: "between" } },
        { messageId: "typedApi", data: { helper: "and" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { not, sql } from "drizzle-orm";
        db.select()
          .from(users)
          .where(
            not(
              sql\`\${users.id} = \${1} AND \${users.name} = \${"name"}\`,
            ),
          );
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "eq" } },
      ],
    },
  ],
});

ruleTester.run(
  "prefer-drizzle-apis read queries",
  preferDrizzleApis,
  queryBuilderReadCases,
);
