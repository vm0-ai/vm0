import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noGlobalSweepTestRoutes } from "../rules/no-global-sweep-test-routes.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const harness =
  "/app/src/signals/routes/__tests__/global-sweep-contracts.test.ts";
const behaviorTest =
  "/app/src/signals/routes/__tests__/stripe-automation-events.test.ts";

const helperImport = `
  import { expectGlobalSweepMissingAuth } from "./helpers/global-sweep-contract";
`;
const routeImport = `
  import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
`;

ruleTester.run("no-global-sweep-test-routes", noGlobalSweepTestRoutes, {
  valid: [
    {
      name: "production bootstrap keeps global behavior",
      filename: "/app/src/signals/route.ts",
      code: `${routeImport}
        export const ROUTES = [...cronExecuteWorkflowAutomationsRoutes];
      `,
    },
    {
      name: "contract harness passes the route directly to the fixed no-auth helper",
      filename: harness,
      code: `${routeImport}${helperImport}
        await expectGlobalSweepMissingAuth(
          context,
          cronExecuteWorkflowAutomationsRoutes,
          "/api/cron/execute-workflow-automations",
        );
      `,
    },
    {
      name: "contract harness admits the fixed wrong-auth helper",
      filename: harness,
      code: `${routeImport}
        import { expectGlobalSweepWrongAuth } from "./helpers/global-sweep-contract";
        await expectGlobalSweepWrongAuth(
          context,
          cronExecuteWorkflowAutomationsRoutes,
          "/api/cron/execute-workflow-automations",
        );
      `,
    },
    {
      name: "automation correctness uses the scoped automation-id executor",
      filename: behaviorTest,
      code: `
        import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
        const executeAutomation = (scenario) => setupApp({
          context,
          routes: testWorkflowAutomationExecutionRoutes,
        }).request("/api/test/workflow-automation-execution", {
          method: "POST",
          body: JSON.stringify({ automation_id: scenario.automationId }),
        });
        expect((await executeAutomation(scenario)).body).toStrictEqual({
          success: true,
          executed: 1,
          skipped: 0,
        });
      `,
    },
    {
      name: "scoped route factory from the production module stays valid",
      filename: behaviorTest,
      code: `
        import { cronComputerUseScreenshotCleanupRoutesForTest } from "../cron-computer-use-screenshot-cleanup";
        setupApp({ routes: cronComputerUseScreenshotCleanupRoutesForTest(commandIds) });
      `,
    },
    {
      name: "public model rankings do not mount the aggregation sweep",
      filename: behaviorTest,
      code: `
        import { modelStatsPublicRoutes } from "../model-stats";
        setupApp({ routes: modelStatsPublicRoutes });
      `,
    },
  ],
  invalid: [
    {
      name: "aggregate routes cannot flow through a local member projection",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        const options = { routes: ROUTES };
        createApp({ signal, routes: options.routes });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate routes cannot flow through local object destructuring",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { setupApp } from "../../../__tests__/test-helpers";
        const options = { routes: ROUTES };
        const { routes } = options;
        setupApp({ context, routes })(contract);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate contract binder aliases remain rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { setupApp } from "../../../__tests__/test-helpers";
        const bindContract = setupApp({ context, routes: ROUTES });
        const client = bindContract(contract);
        await client.execute({
          headers: { authorization: "Bearer test-cron-secret" },
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate app options aliases remain rejected",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        const options = { signal, routes: ROUTES };
        const app = createApp(options);
        await app.request("/api/cron/execute-workflow-automations", {
          headers: { authorization: "Bearer test-cron-secret" },
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate production routes cannot become a ts-rest behavior client",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { setupApp } from "../../../__tests__/test-helpers";
        const client = setupApp({ context, routes: ROUTES })(contract);
        await client.execute({
          headers: { authorization: "Bearer test-cron-secret" },
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "aggregate production routes cannot become a behavior-test sweep",
      filename: behaviorTest,
      code: `
        import { ROUTES } from "../../route";
        import { createApp } from "../../../app-factory";
        const aggregateRoutes = ROUTES;
        const app = createApp({ signal, routes: aggregateRoutes });
        await app.request("/api/cron/execute-workflow-automations", {
          headers: { authorization: "Bearer test-cron-secret" },
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "old behavior helper cannot wrap the production-global sweep",
      filename: behaviorTest,
      code: `${routeImport}
        import { createApp } from "../../../app-factory";
        async function executeCron() {
          return await createApp({
            signal,
            routes: cronExecuteWorkflowAutomationsRoutes,
          }).request("/api/cron/execute-workflow-automations", {
            headers: { authorization: "Bearer test-cron-secret" },
          });
        }
        await executeCron();
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot rename a global route import",
      filename: harness,
      code: `
        import { cronExecuteWorkflowAutomationsRoutes as sweep } from "../cron-execute-workflow-automations";
        ${helperImport}
        await expectGlobalSweepMissingAuth(context, sweep, "/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot alias a route locally",
      filename: harness,
      code: `${routeImport}${helperImport}
        const sweep = cronExecuteWorkflowAutomationsRoutes;
        await expectGlobalSweepMissingAuth(context, sweep, "/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot put a route in a local array",
      filename: harness,
      code: `${routeImport}${helperImport}
        const routes = [...cronExecuteWorkflowAutomationsRoutes];
        await expectGlobalSweepMissingAuth(context, routes, "/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot pass a route through a local wrapper",
      filename: harness,
      code: `${routeImport}${helperImport}
        async function check(routes) {
          await expectGlobalSweepMissingAuth(context, routes, "/api/cron/execute-workflow-automations");
        }
        await check(cronExecuteWorkflowAutomationsRoutes);
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot re-export a global route",
      filename: harness,
      code: `export { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot star re-export a global route module",
      filename: harness,
      code: `export * from "../cron-execute-workflow-automations";`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot mount a route with createApp",
      filename: harness,
      code: `${routeImport}
        import { createApp } from "../../../app-factory";
        await createApp({ signal, routes: cronExecuteWorkflowAutomationsRoutes })
          .request("/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot mount a route with setupApp",
      filename: harness,
      code: `${routeImport}
        await setupApp({
          context,
          routes: cronExecuteWorkflowAutomationsRoutes,
        })(cronExecuteWorkflowAutomationsContract).execute({
          headers: {},
        });
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "approved filename cannot make an authorized behavior call",
      filename: harness,
      code: `${routeImport}${helperImport}
        import { createApp } from "../../../app-factory";
        const response = await createApp({
          signal,
          routes: cronExecuteWorkflowAutomationsRoutes,
        }).request("/api/cron/execute-workflow-automations", {
          headers: { authorization: "Bearer test-cron-secret" },
        });
        expect(response.status).toBe(200);
        await expectGlobalSweepMissingAuth(context, cronExecuteWorkflowAutomationsRoutes, "/api/cron/execute-workflow-automations");
      `,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "namespace import cannot hide the sweep",
      filename: behaviorTest,
      code: `import * as cron from "../cron-execute-workflow-automations"; cron.cronExecuteWorkflowAutomationsRoutes;`,
      errors: [{ messageId: "globalSweep" }],
    },
    {
      name: "dynamic import cannot hide the sweep",
      filename: behaviorTest,
      code: `await import("../cron-execute-workflow-automations");`,
      errors: [{ messageId: "globalSweep" }],
    },
  ],
});
