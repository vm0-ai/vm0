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
        sql\`MAX(\${fragment})\`;
        sql\`SUM(\${users.id})\`;
        sql\`SELECT MIN(\${users.id}) FROM \${users}\`;
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
        sql\`\${users.name} NOT LIKE \${"prefix%"}\`;
        sql\`\${users.name} ILIKE \${"prefix%"}\`;
        sql\`\${users.id} NOT IN (\${mutableList})\`;
        sql\`SELECT \${users.id} DESC\`;
        sql\`ORDER BY \${users.id} DESCENDING\`;
        concrete(sql\`\${condition} AND \${condition}\`);
        sql\`\${condition} AND NOT \${condition}\`;
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
      `,
      errors: [{ messageId: "typedApi", data: { helper: "like" } }],
    },
  ],
});
