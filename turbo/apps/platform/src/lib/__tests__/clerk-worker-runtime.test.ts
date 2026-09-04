import { expect, test } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { startClerkWorkerRuntime } from "../clerk-worker-runtime.ts";

const context = testContext();

test("An Okou worker connects to its satellite Clerk frontend", async () => {
  context.mocks.browser.url("https://app.okou.ai/shared-database-worker.js");
  const clerk = context.mocks.clerk();

  await startClerkWorkerRuntime({
    devBrowserJwt: null,
    productionPrimaryAppDomain: "app.vm0.ai",
  });

  expect(clerk.worker.initializations).toStrictEqual([
    {
      domain: "clerk.app.okou.ai",
      publishableKey: "test_production_key",
    },
  ]);
  expect(clerk.worker.loads).toStrictEqual([{ standardBrowser: false }]);
});

test("A VM0 worker connects to the root satellite after primary cutover", async () => {
  context.mocks.browser.url("https://app.vm0.ai/shared-database-worker.js");
  const clerk = context.mocks.clerk();

  await startClerkWorkerRuntime({
    devBrowserJwt: null,
    productionPrimaryAppDomain: "app.okou.ai",
  });

  expect(clerk.worker.initializations).toStrictEqual([
    {
      domain: "clerk.vm0.ai",
      publishableKey: "test_production_key",
    },
  ]);
  expect(clerk.worker.loads).toStrictEqual([{ standardBrowser: false }]);
});

test("A development worker follows Clerk dev-browser token rotation", async () => {
  context.mocks.browser.url("http://localhost:3000/shared-database-worker.js");
  const clerk = context.mocks.clerk();

  await startClerkWorkerRuntime({
    devBrowserJwt: "initial-worker-jwt",
    productionPrimaryAppDomain: null,
  });

  const firstRequest = new URL(
    clerk.worker.request("https://clerk.example.test/v1/client"),
  );
  expect(firstRequest.searchParams.get("__clerk_db_jwt")).toBe(
    "initial-worker-jwt",
  );

  clerk.worker.respond({ "Clerk-Db-Jwt": "rotated-worker-jwt" });

  const nextRequest = new URL(
    clerk.worker.request("https://clerk.example.test/v1/session"),
  );
  expect(nextRequest.searchParams.get("__clerk_db_jwt")).toBe(
    "rotated-worker-jwt",
  );
});
