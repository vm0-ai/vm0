import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noUnsafeSqlInterpolation } from "../rules/no-unsafe-sql-interpolation.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const drizzlePreamble = `
  import { relations } from "drizzle-orm";
  import { integer, pgTable, text } from "drizzle-orm/pg-core";

  const users = pgTable("users", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
    tags: text("tags").array().notNull(),
  });
  const usersRelations = relations(users, () => ({}));
  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase<{
      users: typeof users;
      usersRelations: typeof usersRelations;
    }>;
  declare const db: DrizzleDatabase;
`;

ruleTester.run("no-unsafe-sql-interpolation", noUnsafeSqlInterpolation, {
  valid: [
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        const values: readonly string[] = ["one", "two"];
        declare const wrapper: SQL | typeof users.id;
        declare const unknownValue: unknown;
        sql\`
          \${"value"}
          \${null}
          \${users}
          \${users.tags}
          \${sql.param(values)}
          \${sql.param(unknownValue)}
          \${sql.join([sql\`one\`, sql\`two\`], sql\`, \`)}
          \${sql.empty()}
          \${wrapper}
        \`;
      `,
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        const query = drizzle.sql;
        query\`\${users.id} = \${1}\`;
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`\${fields.name} = \${"name"}\`,
        });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQLWrapper } from "drizzle-orm";
        function interpolateBound<T extends string | number>(value: T) {
          return sql\`\${value}\`;
        }
        function interpolateWrapper<T extends SQLWrapper>(value: T) {
          return sql\`\${value}\`;
        }
        void interpolateBound;
        void interpolateWrapper;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { and, eq, or, sql, type SQL } from "drizzle-orm";
        import * as drizzle from "drizzle-orm";
        declare const optionalCondition: SQL | undefined;
        declare const optionalConditions: readonly (SQL | undefined)[];
        const fixedConditions = [
          eq(users.id, 1),
          optionalCondition,
        ] as const;
        sql\`\${and(eq(users.id, 1), optionalCondition)}\`;
        sql\`\${or(eq(users.id, 1), ...optionalConditions)}\`;
        sql\`\${drizzle.and(drizzle.eq(users.id, 1), undefined)}\`;
        sql\`\${and(or(eq(users.id, 1), optionalCondition), optionalCondition)}\`;
        sql\`\${and(...fixedConditions)}\`;
      `,
    },
    {
      code: `
        function sql(strings: TemplateStringsArray, ...values: unknown[]) {
          return { strings, values };
        }
        declare const value: any;
        sql\`\${value}\`;
      `,
    },
  ],
  invalid: [
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare const value: any;
        sql\`\${value}\`;
      `,
      errors: [{ messageId: "anyInterpolation" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql as query } from "drizzle-orm";
        declare const value: unknown;
        query\`\${value}\`;
      `,
      errors: [{ messageId: "unknownInterpolation" }],
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        declare const value: string | undefined;
        drizzle.sql\`\${value}\`;
        drizzle.sql\`\${undefined}\`;
      `,
      errors: [
        { messageId: "undefinedInterpolation" },
        { messageId: "undefinedInterpolation" },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = sql;
        declare const values: readonly string[];
        declare const tuple: readonly [string, number];
        declare const mixedValues: string | string[];
        query\`\${values} \${tuple} \${mixedValues}\`;
      `,
      errors: [
        { messageId: "arrayInterpolation" },
        { messageId: "arrayInterpolation" },
        { messageId: "arrayInterpolation" },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { type SQL } from "drizzle-orm";
        declare const mixed: string | SQL;
        db.query.users.findMany({
          where: (_fields, operators) => operators.sql\`\${mixed}\`,
        });
      `,
      errors: [{ messageId: "mixedInterpolation" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        declare const mixed: SQL | null;
        sql\`\${mixed}\`;
      `,
      errors: [{ messageId: "mixedInterpolation" }],
    },
    {
      code: `${drizzlePreamble}
        import { and, or, sql, type SQL } from "drizzle-orm";
        declare const optionalCondition: SQL | undefined;
        declare const optionalConditions: readonly (SQL | undefined)[];
        declare function localAnd(condition: SQL): SQL | undefined;
        sql\`\${and(optionalCondition)}\`;
        sql\`\${and(...optionalConditions)}\`;
        sql\`\${and(or(optionalCondition), optionalCondition)}\`;
        sql\`\${localAnd(sql\`true\`)}\`;
      `,
      errors: [
        { messageId: "undefinedInterpolation" },
        { messageId: "undefinedInterpolation" },
        { messageId: "undefinedInterpolation" },
        { messageId: "undefinedInterpolation" },
      ],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare function returnsVoid(): void;
        sql\`\${returnsVoid()}\`;
      `,
      errors: [{ messageId: "undefinedInterpolation" }],
    },
  ],
});
