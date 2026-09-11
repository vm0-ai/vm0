import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium } from "@playwright/test";

import { expectClerkTestInstance } from "./auth";

// Exercise the fixture guard in a browser without connecting test credentials
// to a live Clerk instance. Only the external SDK runtime is supplied here.
test("auth fixtures require a loaded Clerk test instance", async (context) => {
  const browser = await chromium.launch();
  try {
    await context.test(
      "accepts a test instance after script cleanup",
      async () => {
        const page = await browser.newPage();
        try {
          await page.setContent(`
          <script data-clerk-publishable-key="pk_test_fixture">
            window.Clerk = { loaded: true, publishableKey: "pk_test_fixture" };
            document.currentScript.remove();
          </script>
        `);
          await expectClerkTestInstance(page);
        } finally {
          await page.close();
        }
      },
    );

    for (const scenario of [
      {
        name: "a production instance",
        runtime: { loaded: true, publishableKey: "pk_live_fixture" },
      },
      { name: "a missing instance", runtime: undefined },
      {
        name: "an unloaded test instance",
        runtime: { loaded: false, publishableKey: "pk_test_fixture" },
      },
      { name: "a missing key", runtime: { loaded: true } },
      {
        name: "an empty key",
        runtime: { loaded: true, publishableKey: "" },
      },
      {
        name: "an invalid key",
        runtime: { loaded: true, publishableKey: "invalid" },
      },
      {
        name: "a non-string key",
        runtime: { loaded: true, publishableKey: 42 },
      },
    ]) {
      await context.test(
        `rejects ${scenario.name} despite a test script`,
        async () => {
          const page = await browser.newPage();
          try {
            await page.setContent(`
            <script data-clerk-publishable-key="pk_test_fixture">
              window.Clerk = ${JSON.stringify(scenario.runtime)};
            </script>
          `);
            await assert.rejects(
              () => expectClerkTestInstance(page),
              /Auth fixtures require a loaded Clerk test instance/u,
            );
          } finally {
            await page.close();
          }
        },
      );
    }
  } finally {
    await browser.close();
  }
});
