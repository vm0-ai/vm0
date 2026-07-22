import { RuleTester } from "@typescript-eslint/rule-tester";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import { preferDrizzleApis } from "../rules/prefer-drizzle-apis.ts";

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

ruleTester.run("prefer-drizzle-apis", preferDrizzleApis, {
  valid: [
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
        import { and, eq, isNotNull, or, sql } from "drizzle-orm";
        const selected = db
          .select({ id: users.id })
          .from(users)
          .as("selected_users");
        const dynamicCondition = sql\`true\`;
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
        db.select()
          .from(users)
          .innerJoinLateral(selected, dynamicCondition);
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
  ],
  invalid: [
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
        import { eq, sql as query } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        const condition = eq(users.id, 1);
        const nameSql = query\`\${users.name}\`.mapWith(users.name);
        const aliasedNameSql = nameSql.as("aliased_name");
        const selected = db.select({ id: users.id }).from(users);
        const tag = drizzle.sql;
        query\`NOT \${condition}\`;
        drizzle.sql\`WHERE NOT \${condition} AND \${condition}\`;
        tag\`\${users.name} NOT LIKE \${"prefix%"} ESCAPE '\\\\'\`;
        query\`\${users.name} ILIKE \${"prefix%"}\`;
        drizzle.sql\`\${users.name} NOT ILIKE \${query\`LOWER(\${"prefix%"})\`}\`;
        tag\`\${nameSql} ILIKE \${"prefix%"}\`;
        query\`\${aliasedNameSql} NOT LIKE \${"prefix%"}\`;
        tag\`\${users.id} BETWEEN \${1} AND \${2}\`;
        tag\`\${users.deletedAt} BETWEEN \${"2026-01-01"}::timestamp AND \${"2026-01-02"}::timestamp\`;
        query\`WHERE \${users.id} NOT BETWEEN \${1} AND \${2} ORDER BY 1\`;
        drizzle.sql\`EXISTS \${selected}\`;
        tag\`NOT EXISTS \${selected}\`;
        function pattern<T extends typeof users.name>(left: T) {
          query\`\${left} NOT ILIKE \${"prefix%"}\`;
        }
        void pattern;
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
        sql\`\${users.tags} <@ \${tagsSql}\`;
        sql\`\${users.tags} && \${tagsSql}\`;
        sql\`\${typedTagsSql} @> \${tagsSql}\`;
        sql\`\${aliasedTagsSql} <@ \${tagsSql}\`;
        function overlaps<T extends typeof users.tags>(left: T, right: SQLWrapper) {
          sql\`\${left} && \${right}\`;
        }
        function overlapsSql<T extends SQL<string[]>>(left: T, right: SQLWrapper) {
          sql\`\${left} && \${right}\`;
        }
        void overlaps;
        void overlapsSql;
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
        sql\`SELECT COUNT(*)::int, COUNT(*) FILTER (WHERE \${condition}) FROM \${users}\`;
        sql\`SELECT SUM(\${users.id}) FROM \${users}\`;
        sql\`SELECT COUNT(\${users.id}) FROM \${users}\`;
        sql\`SELECT COUNT(DISTINCT \${users.id}) FROM \${users}\`;
        sql\`SELECT AVG(\${users.id}) FROM \${users}\`;
        sql\`SELECT AVG(DISTINCT \${users.id}) FROM \${users}\`;
        sql\`SELECT SUM(DISTINCT \${users.id}) FROM \${users}\`;
        sql\`SELECT MIN(\${users.id}) FROM \${users}\`;
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
        import { and, eq, isNotNull, sql } from "drizzle-orm";
        sql\`EXISTS (
          SELECT 1
          FROM \${users}
          WHERE \${eq(users.id, 1)}
            AND \${isNotNull(users.name)}
        )\`;
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
        query\` not   exists(
          select 1 from \${users}
          inner join \${otherUsers} on \${eq(otherUsers.id, users.id)}
          where \${eq(users.id, 1)} and \${isNotNull(otherUsers.name)}
          limit 1
        ) \`;
        drizzle.sql\`EXISTS (SELECT 1 FROM \${otherUsers} WHERE \${eq(otherUsers.id, 1)})\`;
        tag\`NOT EXISTS (SELECT 1 FROM \${users} WHERE \${eq(users.id, 1)})\`;
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
        sql\`EXISTS (SELECT 1 FROM \${users} WHERE \${users.id} = \${1})\`;
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
        db.select()
          .from(users)
          .innerJoinLateral(selected, query\` true \`);
        db.select()
          .from(users)
          .innerJoinLateral(selected, drizzle.sql\`TRUE\`);
      `,
      errors: [
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
        sql\`\${users.id} = \${value}\`;
        sql\`\${users.id} <> \${value}\`;
        sql\`\${users.id} > \${value}\`;
        sql\`\${users.id} >= \${value}\`;
        sql\`\${users.id} < \${value}\`;
        sql\`\${users.id} <= \${value}\`;
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
        query\` \${users.deletedAt}  is   null \`;
        query\`\${users.deletedAt}\nIS NOT NULL\`;
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "isNull" } },
        { messageId: "typedApi", data: { helper: "isNotNull" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        drizzle.sql\`MAX ( \${users.id} )\`;
        const query = drizzle.sql;
        query\`min(\${users.id})\`;
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
        sql\`\${selected.id} > \${users.id}\`;
      `,
      errors: [{ messageId: "typedApi", data: { helper: "gt" } }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const value = 1;
        sql\`(\${users.id} = \${value})\`;
        sql\`\${users.deletedAt} >= \${"2026-01-01"}::timestamp\`;
        sql\`\${users.deletedAt} < \${"2026-01-02"}::timestamptz AT TIME ZONE 'UTC' ORDER BY 1\`;
        sql\`
          SELECT \${users.id}
          FROM \${users}
          WHERE \${users.id} >= \${value}
            AND \${users.deletedAt} IS NOT NULL
        \`;
        sql\`CASE
          WHEN \${users.id} > \${value} AND \${users.id} <> \${value}
          THEN \${users.name}
          ELSE NULL
        END\`;
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "gte" } },
        { messageId: "typedApi", data: { helper: "lt" } },
        { messageId: "typedApi", data: { helper: "gte" } },
        { messageId: "typedApi", data: { helper: "isNotNull" } },
        { messageId: "typedApi", data: { helper: "gt" } },
        { messageId: "typedApi", data: { helper: "ne" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`(\${fields.id} > \${0}) OR \${fields.deletedAt} IS NULL\`,
        });
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "gt" } },
        { messageId: "typedApi", data: { helper: "isNull" } },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQLWrapper } from "drizzle-orm";
        function predicates<T extends SQLWrapper>(left: T, right: string) {
          sql\`\${left} = \${right}\`;
          sql\`\${left} IS NOT NULL\`;
        }
        function aggregate<T extends typeof users.id>(column: T) {
          return sql\`MAX(\${column})\`;
        }
        void predicates;
        void aggregate;
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
        function optional(value: SQL | undefined): SQL | undefined {
          return value;
        }
        const condition = eq(users.id, 1);
        const jsonArray = sql\`jsonb_build_array(\${"tag"})\`;
        sql\`\${users.name} LIKE \${"prefix%"} ESCAPE '\\\\'\`;
        sql\`\${users.name} IN (\${nameList})\`;
        sql\`\${users.name} IN (\${nameSqlList()})\`;
        sql\`\${users.name} NOT IN (\${nameList})\`;
        sql\`\${users.name} NOT IN (\${nameSqlList()})\`;
        sql\`ORDER BY \${users.name} ASC, \${users.id} DESC NULLS FIRST\`;
        sql\`COALESCE(SUM(\${users.id}), 0)\`;
        sql\`COUNT(\${users.id}) FILTER (WHERE \${condition})::int\`;
        sql\`MAX(\${users.deletedAt}) FILTER (WHERE \${condition})\`;
        sql\`SELECT COUNT(\${users.id}), COUNT(DISTINCT \${users.name}), MAX(\${users.id}) FROM \${users}\`;
        optional(sql\`(\${condition} AND \${condition}) OR \${condition}\`);
        sql\`\${users.tags} @> \${jsonArray}\`;
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
        import { sql as query, type SQLWrapper } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        const names = ["one", "two"];
        const nameList = drizzle.sql.join(
          names.map((name) => drizzle.sql\`\${name}\`),
          drizzle.sql\`, \`,
        );
        query\`\${users.name} LIKE \${"prefix%"}\`;
        drizzle.sql\`\${users.name} IN (\${nameList})\`;
        drizzle.sql\`ORDER BY \${users.name} ASC, COALESCE(SUM(\${users.id}), 0)\`;
        function contains<T extends typeof users.tags>(column: T, value: SQLWrapper) {
          query\`\${column} @> \${value}\`;
        }
        void contains;
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
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "like" } },
        { messageId: "typedApi", data: { helper: "not" } },
        { messageId: "typedApi", data: { helper: "ilike" } },
        { messageId: "typedApi", data: { helper: "between" } },
      ],
    },
  ],
});
