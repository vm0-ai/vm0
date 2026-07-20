import { RuleTester } from "@typescript-eslint/rule-tester";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import { requireSqlResultMapping } from "../rules/require-sql-result-mapping.ts";

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
  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase;
  declare const db: DrizzleDatabase;

  import { integer, pgTable, text } from "drizzle-orm/pg-core";
  const users = pgTable("users", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
  });
`;

ruleTester.run("require-sql-result-mapping", requireSqlResultMapping, {
  valid: [
    {
      code: `${drizzlePreamble}
        db.select();
        db.select({ name: users.name });
        db.selectDistinct({ name: users.name });
        db.selectDistinctOn([users.id], { name: users.name });
        db.update(users).set({ name: "updated" }).returning();
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select({
          value: sql\`upper(\${users.name})\`.mapWith(users.name),
          aliased: sql\`lower(\${users.name})\`.mapWith(users.name).as("value"),
        });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        function mappedValue() {
          return sql\`upper(\${users.name})\`.mapWith(users.name);
        }
        const messageColumns = {
          direct: sql\`lower(\${users.name})\`.mapWith(users.name),
          helper: mappedValue(),
        } as const;
        db.select(messageColumns);
        db.select({ nested: messageColumns });
        db.select({ ...messageColumns });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql, type DriverValueDecoder } from "drizzle-orm";
        declare const nullableTextDecoder:
          DriverValueDecoder<string | null, unknown>;
        db.select({
          nullableValue: sql\`NULLIF(\${users.name}, '')\`
            .mapWith(nullableTextDecoder),
        });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { count, sql } from "drizzle-orm";
        db.select({
          count: count(sql\`CASE WHEN \${users.id} > 0 THEN 1 END\`),
          nested: sql\`coalesce(\${sql\`nullif(\${users.name}, '')\`}, '')\`
            .mapWith(users.name),
        });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const left = db.select({
          value: sql\`'left'\`.mapWith(users.name),
        });
        const right = db.select({
          value: sql\`'right'\`.mapWith(users.name),
        });
        left.unionAll(right);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare const condition: boolean;
        db.select({
          value: condition
            ? sql\`'left'\`.mapWith(users.name)
            : sql\`'right'\`.mapWith(users.name),
        });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.selectDistinct({
          value: sql\`upper(\${users.name})\`.mapWith(users.name),
        });
        db.selectDistinctOn(
          [sql\`lower(\${users.name})\`],
          { value: sql\`upper(\${users.name})\`.mapWith(users.name) },
        );
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.update(users)
          .set({ name: sql\`upper(\${users.name})\` })
          .returning({ name: users.name });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        await db.select()
          .from(users)
          .where(sql\`\${users.id} > 0\`)
          .groupBy(sql\`\${users.id}\`)
          .orderBy(sql\`\${users.name}\`);
        await db.update(users).set({
          name: sql\`upper(\${users.name})\`,
        });
        await db.execute(sql\`DELETE FROM users\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { eq, or, sql, type SQL } from "drizzle-orm";
        function condition(): SQL {
          return sql\`\${users.id} > 0\`;
        }
        const narrowed = or(
          eq(users.id, 1),
          eq(users.id, 2),
        ) as SQL;
        await db.select().from(users).where(condition());
        await db.select().from(users).where(narrowed);
      `,
    },
    {
      code: `
        function sql<T>(strings: TemplateStringsArray): T {
          throw new Error(strings[0]);
        }
        interface SQL<T> {
          readonly value: T;
        }
        const localValue = sql<string>\`value\`;
        const localTyped: SQL<string> = { value: "value" };
        void localValue;
        void localTyped;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql as drizzleSql } from "drizzle-orm";
        function localTag() {
          function sql<T>(strings: TemplateStringsArray): T {
            throw new Error(strings[0]);
          }
          return sql<string>\`local\`;
        }
        db.select({
          value: drizzleSql\`upper(\${users.name})\`.mapWith(users.name),
        });
        void localTag;
      `,
    },
    {
      code: `
        interface Builder {
          as<T>(alias: string): T;
        }
        interface Repository {
          select<T>(fields: T): T;
        }
        declare const builder: Builder;
        declare const repository: Repository;
        const value = builder.as<string>("value");
        repository.select({ value });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        const fields = { value: sql\`upper(\${users.name})\` } as const;
        const preserved = fields as { readonly value: SQL };
        void fields;
        void preserved;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        interface Repository {
          select<T>(fields: T): T;
        }
        declare const repository: Repository;
        repository.select({
          value: sql\`upper(\${users.name})\`,
        });
      `,
    },
  ],
  invalid: [
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const value = sql<string>\`upper(\${users.name})\`;
      `,
      errors: [{ messageId: "sqlTypeArgument" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql as drizzleSql } from "drizzle-orm";
        const value = drizzleSql<string>\`upper(\${users.name})\`;
      `,
      errors: [{ messageId: "sqlTypeArgument" }],
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        const value = drizzle.sql<string>\`upper(\${users.name})\`;
      `,
      errors: [{ messageId: "sqlTypeArgument" }],
    },
    {
      code: `${drizzlePreamble}
        const value = sql<string>\`upper(\${users.name})\`;
        import { sql } from "drizzle-orm";
      `,
      errors: [{ messageId: "sqlTypeArgument" }],
    },
    {
      code: `
        import type { SQL } from "drizzle-orm";
        declare const value: SQL<string>;
      `,
      errors: [{ messageId: "sqlTypeReference" }],
    },
    {
      code: `
        import type { SQL as DrizzleSql } from "drizzle-orm";
        type Value = DrizzleSql<string>;
      `,
      errors: [{ messageId: "sqlTypeReference" }],
    },
    {
      code: `
        import type * as drizzle from "drizzle-orm";
        interface Holder {
          readonly value: drizzle.SQL<string>;
        }
      `,
      errors: [{ messageId: "sqlTypeReference" }],
    },
    {
      code: `
        import type { SQL } from "drizzle-orm";
        declare const value: SQL.Aliased<string>;
      `,
      errors: [{ messageId: "sqlTypeReference" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const value = sql\`upper(\${users.name})\`.as<string>("value");
      `,
      errors: [{ messageId: "sqlAliasTypeArgument" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const value = sql\`upper(\${users.name})\`.as<string>();
      `,
      errors: [{ messageId: "sqlAliasTypeArgument" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const hidden = { value: sql\`upper(\${users.name})\` } as unknown;
      `,
      errors: [{ messageId: "sqlAssertion" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const fields = { value: sql\`upper(\${users.name})\` };
        const hidden = fields as { readonly value: string };
        db.select(hidden);
      `,
      errors: [{ messageId: "sqlAssertion" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select({ value: sql\`upper(\${users.name})\` });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select({ value: sql\`upper(\${users.name})\`.as("value") });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const messageColumns = {
          value: sql\`upper(\${users.name})\`,
        };
        db.select(messageColumns);
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const fields = { value: sql\`upper(\${users.name})\` };
        db.select({ ...fields });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.select({
          nested: { value: sql\`upper(\${users.name})\` },
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        function value() {
          return sql\`upper(\${users.name})\`;
        }
        db.select({ value: value() });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        function fields() {
          return { value: sql\`upper(\${users.name})\` };
        }
        db.select(fields());
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare const condition: boolean;
        db.select({
          value: condition
            ? sql\`'left'\`.mapWith(users.name)
            : sql\`'right'\`,
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.selectDistinct({
          value: sql\`upper(\${users.name})\`,
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.selectDistinctOn(
          [sql\`lower(\${users.name})\`],
          { value: sql\`upper(\${users.name})\` },
        );
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.update(users)
          .set({ name: sql\`upper(\${users.name})\` })
          .returning({ value: sql\`lower(\${users.name})\` });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const left = db.select({ value: sql\`'left'\` });
        const right = db.select({
          value: sql\`'right'\`.mapWith(users.name),
        });
        left.unionAll(right);
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const left = db.select({
          value: sql\`'left'\`.mapWith(users.name),
        });
        const right = db.select({ value: sql\`'right'\` });
        left.unionAll(right);
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = db.select({
          value: sql\`upper(\${users.name})\`,
        });
        const rows = await query as { readonly value: string }[];
        void rows;
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        const fields: { readonly value: SQL<string> } = {
          value: sql\`upper(\${users.name})\`,
        };
        void fields;
      `,
      errors: [{ messageId: "sqlTypeReference" }],
    },
  ],
});
