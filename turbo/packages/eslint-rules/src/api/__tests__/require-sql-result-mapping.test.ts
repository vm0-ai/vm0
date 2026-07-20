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

const relationalPreamble = `
  import { relations } from "drizzle-orm";
  import { integer, pgTable, text } from "drizzle-orm/pg-core";

  const users = pgTable("users", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
  });
  const posts = pgTable("posts", {
    id: integer("id").notNull(),
    authorId: integer("author_id").notNull(),
    title: text("title").notNull(),
  });
  const usersRelations = relations(users, ({ many }) => ({
    posts: many(posts),
  }));
  const postsRelations = relations(posts, ({ one }) => ({
    author: one(users, {
      fields: [posts.authorId],
      references: [users.id],
    }),
  }));

  type DrizzleDatabase =
    import("drizzle-orm/node-postgres").NodePgDatabase<{
      users: typeof users;
      posts: typeof posts;
      usersRelations: typeof usersRelations;
      postsRelations: typeof postsRelations;
    }>;
  declare const db: DrizzleDatabase;
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
        db.select({
          get value() {
            return sql\`upper(\${users.name})\`.mapWith(users.name);
          },
        });
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        db.insert(users).select(sql\`SELECT 1, 'name'\`);
        db.insert(users).select(...[sql\`SELECT 1, 'name'\`] as const);
        const insertSelect = db.insert(users).select;
        const method = "select" as const;
        db.insert(users)[method](sql\`SELECT 1, 'name'\`);
        void insertSelect;
      `,
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`\${fields.id} > 0\`,
          extras: {
            normalizedName: sql\`upper(\${users.name})\`
              .mapWith(users.name)
              .as("normalized_name"),
          },
          with: {
            posts: {
              extras: (fields, operators) => ({
                normalizedTitle: operators.sql\`upper(\${fields.title})\`
                  .mapWith(fields.title)
                  .as("normalized_title"),
              }),
            },
          },
        });
        db.query.users.findFirst({
          extras: (fields, operators) => ({
            normalizedName: operators.sql\`upper(\${fields.name})\`
              .mapWith(fields.name)
              .as("normalized_name"),
          }),
        });
        db.query.users.findMany({ with: { posts: true } });
        db.query.users.findMany(undefined);
        db.query.users.findFirst({
          extras: (fields, operators) => {
            return {
              normalizedName: operators.sql\`upper(\${fields.name})\`
                .mapWith(fields.name)
                .as("normalized_name"),
            };
          },
        });
      `,
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        type UsersQueryConfig = NonNullable<
          Parameters<typeof db.query.users.findMany>[0]
        >;
        const columnsOnly: UsersQueryConfig = {
          columns: { id: true },
        };
        const mapped: UsersQueryConfig = {
          extras: {
            normalizedName: sql\`upper(\${users.name})\`
              .mapWith(users.name)
              .as("normalized_name"),
          },
        };
        const nested = {
          extras: {
            normalizedTitle: sql\`upper(\${posts.title})\`
              .mapWith(posts.title)
              .as("normalized_title"),
          },
        };
        db.query.users.findMany(columnsOnly);
        db.query.users.findMany(mapped);
        db.query.users.findMany({ with: { posts: nested } });
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
        const subquery = db
          .select({ name: users.name })
          .from(users)
          .as<"named_users">("named_users");
        void subquery;
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
          .leftJoin(users, sql\`\${users.id} > 0\`)
          .where(sql\`\${users.id} > 0\`)
          .groupBy(sql\`\${users.id}\`)
          .orderBy(sql\`\${users.name}\`);
        await db.update(users).set({
          name: sql\`upper(\${users.name})\`,
        });
        await db.execute(sql\`DELETE FROM users\`);
        const { rowCount } = await db.execute(sql\`DELETE FROM users\`);
        void rowCount;
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
        const localTag = sql<string>;
        const instantiatedLocalValue = localTag\`value\`;
        const localTyped: SQL<string> = { value: "value" };
        void localValue;
        void instantiatedLocalValue;
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
        const alias = builder.as<string>;
        const instantiatedValue = alias("value");
        repository.select({ value });
        void instantiatedValue;
      `,
    },
    {
      code: `
        interface Repository {
          findMany(config: object): readonly unknown[];
        }
        declare const repository: Repository;
        const findMany = repository.findMany;
        void findMany;
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
        repository.select(
          ...[{ value: sql\`upper(\${users.name})\` }] as const,
        );
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
        import { sql } from "drizzle-orm";
        const tag = sql;
        const value = tag<string>\`upper(\${users.name})\`;
      `,
      errors: [{ messageId: "sqlTypeArgument" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const typedSql = sql<string>;
        const value = typedSql\`value\`;
        void value;
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
        import { sql, type SQL } from "drizzle-orm";
        const expression: Pick<SQL, "as"> = sql\`upper(\${users.name})\`;
        const value = expression.as<string>("value");
        db.select({ value });
      `,
      errors: [{ messageId: "sqlAliasTypeArgument" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const expression = sql\`upper(\${users.name})\`;
        const alias = expression.as;
        const value = alias<string>("value");
        db.select({ value });
      `,
      errors: [{ messageId: "sqlAliasTypeArgument" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const expression = sql\`value\`;
        const alias = expression.as<string>;
        void alias;
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
        db.select({
          get value() {
            return sql\`upper(\${users.name})\`;
          },
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        type Fields = NonNullable<
          Parameters<DrizzleDatabase["select"]>[0]
        >;
        function select<TFields extends Fields>(fields: TFields) {
          return db.select(fields);
        }
        select({ value: sql\`upper(\${users.name})\` });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const method = "select" as const;
        db[method]({ value: sql\`upper(\${users.name})\` });
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
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const select = db.select.bind(db);
        select({ value: sql\`upper(\${users.name})\` });
      `,
      errors: [{ messageId: "resultMethodReference" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const args = [
          { value: sql\`upper(\${users.name})\` },
        ] as const;
        db.select(...args);
      `,
      errors: [{ messageId: "uninspectableResultArguments" }],
    },
    {
      code: `${drizzlePreamble}
        const method = "select" as const;
        const select = db[method].bind(db);
        void select;
      `,
      errors: [{ messageId: "resultMethodReference" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const database: Pick<DrizzleDatabase, "select"> = db;
        database.select({ value: sql\`upper(\${users.name})\` });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        interface Selector {
          readonly select: DrizzleDatabase["select"];
        }
        const database: Selector = db;
        database.select({ value: sql\`upper(\${users.name})\` });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const update = db.update(users).set({ name: "updated" });
        const writer: Pick<typeof update, "returning"> = update;
        writer.returning({
          value: sql\`upper(\${users.name})\`,
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${drizzlePreamble}
        const { selectDistinct: select } = db;
        void select;
      `,
      errors: [{ messageId: "resultMethodReference" }],
    },
    {
      code: `${drizzlePreamble}
        const returning = db.update(users).set({ name: "updated" }).returning;
        void returning;
      `,
      errors: [{ messageId: "resultMethodReference" }],
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        db.query.users.findMany({
          extras: {
            normalizedName: sql\`upper(\${users.name})\`.as("normalized_name"),
          },
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        const extras = "extras" as const;
        db.query.users.findMany({
          [extras]: {
            normalizedName: sql\`upper(\${users.name})\`.as("normalized_name"),
          },
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        type UsersQueryConfig = NonNullable<
          Parameters<typeof db.query.users.findMany>[0]
        >;
        const config: UsersQueryConfig = {
          extras: {
            normalizedName: sql\`upper(\${users.name})\`.as("normalized_name"),
          },
        };
        db.query.users.findMany(config);
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        const unsafe = {
          extras: {
            normalizedName: sql\`upper(\${users.name})\`.as("normalized_name"),
          },
        };
        db.query.users.findMany({ ...unsafe });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${relationalPreamble}
        db.query.users.findFirst({
          extras: (fields, operators) => ({
            normalizedName:
              operators.sql\`upper(\${fields.name})\`.as("normalized_name"),
          }),
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${relationalPreamble}
        db.query.users.findFirst({
          extras: (fields, operators) => ({
            normalizedName:
              operators.sql<string>\`upper(\${fields.name})\`
                .as("normalized_name"),
          }),
        });
      `,
      errors: [{ messageId: "sqlTypeArgument" }],
    },
    {
      code: `${relationalPreamble}
        db.query.users.findFirst({
          extras: (fields, operators) => {
            return {
              normalizedName:
                operators.sql\`upper(\${fields.name})\`.as("normalized_name"),
            };
          },
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        const config = {
          extras: {
            normalizedName: sql\`upper(\${users.name})\`.as("normalized_name"),
          },
        };
        db.query.users.findMany(config);
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        db.query.users.findMany({
          with: {
            posts: {
              extras: {
                normalizedTitle:
                  sql\`upper(\${posts.title})\`.as("normalized_title"),
              },
            },
          },
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${relationalPreamble}
        const findMany = db.query.users.findMany.bind(db.query.users);
        void findMany;
      `,
      errors: [{ messageId: "resultMethodReference" }],
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        const args = [{
          extras: {
            normalizedName: sql\`upper(\${users.name})\`.as("normalized_name"),
          },
        }] as const;
        db.query.users.findMany(...args);
      `,
      errors: [{ messageId: "uninspectableResultArguments" }],
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        const shared = {
          normalizedName: sql\`upper(\${users.name})\`.as("normalized_name"),
        };
        db.query.users.findMany({
          with: { posts: shared },
          extras: shared,
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${relationalPreamble}
        declare function config(): {};
        db.query.users.findMany(config());
      `,
      errors: [{ messageId: "uninspectableRelationalConfig" }],
    },
    {
      code: `${relationalPreamble}
        function query(undefined: {}) {
          return db.query.users.findMany(undefined);
        }
        void query;
      `,
      errors: [{ messageId: "uninspectableRelationalConfig" }],
    },
    {
      code: `${relationalPreamble}
        import { sql } from "drizzle-orm";
        const usersQuery: Pick<
          typeof db.query.users,
          "findMany"
        > = db.query.users;
        usersQuery.findMany({
          extras: {
            normalizedName: sql\`upper(\${users.name})\`.as("normalized_name"),
          },
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
  ],
});
