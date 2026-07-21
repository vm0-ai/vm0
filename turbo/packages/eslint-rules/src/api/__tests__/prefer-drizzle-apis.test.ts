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
  import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

  const users = pgTable("users", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
    deletedAt: timestamp("deleted_at"),
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
        sql\`MAX(\${users.id}) FILTER (WHERE \${users.id} > 0)\`;
        sql\`MAX(\${fragment})\`;
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
  ],
  invalid: [
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
  ],
});
