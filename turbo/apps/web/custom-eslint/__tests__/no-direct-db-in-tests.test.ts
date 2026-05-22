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
    {
      // Importing from db-test-seeders is fine
      code: 'import { insertTestUser } from "../db-test-seeders/users";',
    },
    {
      // Importing from non-schema paths is fine
      code: 'import { foo } from "../../lib/services";',
    },
    {
      // Type-only import from service is fine
      code: 'import type { RunStatus } from "../run-service";',
    },
    {
      // Inline type import from service is fine
      code: 'import { type RunStatus } from "../run-service";',
    },
    {
      // Package import with "service" in name is fine (not relative)
      code: 'import { WebClient } from "@slack/web-api";',
    },
    {
      // Test infrastructure import is fine
      code: 'import { createTestRun } from "../__tests__/api-test-helpers";',
    },
    {
      // Non-service relative import is fine
      code: 'import { formatPath } from "../path-utils";',
    },
    {
      code: 'import { agentRuns } from "@vm0/db/schema/agent-run";',
      filename:
        "/workspaces/vm01/turbo/apps/web/src/db/migrations/__tests__/0292_agent_runs_session_id_not_null_fk.test.ts",
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
    {
      code: 'import { users } from "@vm0/db/schema/user";',
      errors: [{ messageId: "noDbSchemaImport" }],
    },
    {
      code: 'import { agentRuns } from "@vm0/db/schema/agent-run";',
      errors: [{ messageId: "noDbSchemaImport" }],
    },
    {
      code: 'import { getMessagesByThreadId } from "../chat-thread/chat-message-service";',
      errors: [{ messageId: "noServiceImport" }],
    },
    {
      code: 'import { adminConnect } from "../../lib/zero/slack-org/connect-service";',
      errors: [{ messageId: "noServiceImport" }],
    },
    {
      code: 'import { type RunStatus, createRun } from "../run-service";',
      errors: [{ messageId: "noServiceImport" }],
    },
  ],
});
