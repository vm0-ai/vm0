import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-direct-db-in-tests.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-direct-db-in-tests", rule, {
  valid: [
    {
      code: "const response = await GET(request);",
    },
    {
      code: "context.setupMocks();",
    },
    {
      code: 'const { composeId } = await createTestCompose("agent");',
    },
    {
      // services.db without globalThis prefix is fine (different variable)
      code: "const x = services.db;",
    },
  ],
  invalid: [
    {
      code: "const db = globalThis.services.db;",
      errors: [{ messageId: "noDirectDb" }],
    },
    {
      code: "await globalThis.services.db.insert(users).values({});",
      errors: [{ messageId: "noDirectDb" }],
    },
    {
      code: `
        const [result] = await globalThis.services.db
          .select()
          .from(users)
          .where(eq(users.id, userId));
      `,
      errors: [{ messageId: "noDirectDb" }],
    },
    {
      code: "initServices();",
      errors: [{ messageId: "noInitServices" }],
    },
    {
      code: `
        beforeEach(() => {
          initServices();
        });
      `,
      errors: [{ messageId: "noInitServices" }],
    },
  ],
});
