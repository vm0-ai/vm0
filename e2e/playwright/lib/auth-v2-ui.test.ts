import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { test } from "node:test";

import { chromium } from "@playwright/test";

import { openAuthV2 } from "./auth-v2-ui";

type AuthV2FixtureMode = "absent" | "delayed" | "incomplete" | "pending";

interface AuthV2Fixture {
  readonly appUrl: string;
  readonly releaseFrontendRequest: (status: number) => void;
  readonly waitForFrontendRequest: () => Promise<void>;
}

const FIXTURE_QUERY_SECRET = "do-not-log-capability";
const FIXTURE_SESSION_ID = "sess_do_not_log";

test("uses a bounded Auth v2 bootstrap boundary", async (context) => {
  const browser = await chromium.launch();
  try {
    await context.test("waits for a delayed Clerk bootstrap", async () => {
      await withAuthV2Fixture("delayed", async (fixture) => {
        const page = await browser.newPage();
        try {
          const opening = openAuthV2(page, fixture.appUrl, {
            timeoutMs: 1_000,
          });
          await fixture.waitForFrontendRequest();
          assert.equal(await page.getByTestId("app-auth-v2").count(), 0);

          fixture.releaseFrontendRequest(200);
          await opening;

          assert.equal(await page.getByTestId("app-auth-v2").count(), 1);
          assert.equal(await page.getByTestId("app-auth-layout").count(), 1);
        } finally {
          await page.close();
        }
      });
    });

    await context.test(
      "reports an unloaded Clerk bootstrap without sensitive request data",
      async () => {
        await withAuthV2Fixture("incomplete", async (fixture) => {
          const page = await browser.newPage();
          try {
            await assert.rejects(
              openAuthV2(page, fixture.appUrl, { timeoutMs: 250 }),
              (error: unknown) => {
                assert(error instanceof Error);
                assert.match(
                  error.message,
                  /ClerkJS present but not loaded; last Clerk request: GET \/v1\/client\/sessions\/\[masked-clerk-resource-id\]\/tokens -> 503/u,
                );
                assert.doesNotMatch(
                  error.message,
                  new RegExp(FIXTURE_QUERY_SECRET),
                );
                assert.doesNotMatch(
                  error.message,
                  new RegExp(FIXTURE_SESSION_ID),
                );
                return true;
              },
            );
          } finally {
            await page.close();
          }
        });
      },
    );

    await context.test("distinguishes an absent ClerkJS global", async () => {
      await withAuthV2Fixture("absent", async (fixture) => {
        const page = await browser.newPage();
        try {
          await assert.rejects(
            openAuthV2(page, fixture.appUrl, { timeoutMs: 250 }),
            /ClerkJS absent; last Clerk request: GET \/v1\/client\/sessions\/\[masked-clerk-resource-id\]\/tokens -> 200/u,
          );
        } finally {
          await page.close();
        }
      });
    });

    await context.test(
      "reports an in-flight Clerk request as pending",
      async () => {
        await withAuthV2Fixture("pending", async (fixture) => {
          const page = await browser.newPage();
          try {
            await assert.rejects(
              openAuthV2(page, fixture.appUrl, { timeoutMs: 250 }),
              /ClerkJS present but not loaded; last Clerk request: GET \/v1\/client\/sessions\/\[masked-clerk-resource-id\]\/tokens -> pending/u,
            );
            fixture.releaseFrontendRequest(503);
          } finally {
            await page.close();
          }
        });
      },
    );
  } finally {
    await browser.close();
  }
});

async function withAuthV2Fixture<Result>(
  mode: AuthV2FixtureMode,
  use: (fixture: AuthV2Fixture) => Promise<Result>,
): Promise<Result> {
  let frontendResponse: ServerResponse | undefined;
  let resolveFrontendRequest!: () => void;
  const frontendRequest = new Promise<void>((resolve) => {
    resolveFrontendRequest = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/v1/")) {
      frontendResponse = response;
      resolveFrontendRequest();
      if (mode === "absent") {
        releaseResponse(response, 200);
      } else if (mode === "incomplete") {
        releaseResponse(response, 503);
      }
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(authV2FixtureDocument(mode));
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("Auth v2 fixture server did not expose a TCP address");
  }

  const previousFrontendApi = process.env.CLERK_FAPI;
  process.env.CLERK_FAPI = `127.0.0.1:${address.port}`;
  try {
    return await use({
      appUrl: `http://127.0.0.1:${address.port}/v2/sign-up`,
      releaseFrontendRequest: (status: number): void => {
        if (!frontendResponse) {
          throw new Error("Clerk fixture request has not started");
        }
        releaseResponse(frontendResponse, status);
      },
      waitForFrontendRequest: async (): Promise<void> => frontendRequest,
    });
  } finally {
    restoreEnvironmentVariable("CLERK_FAPI", previousFrontendApi);
    if (frontendResponse && !frontendResponse.writableEnded) {
      frontendResponse.destroy();
    }
    await close(server);
  }
}

function authV2FixtureDocument(mode: AuthV2FixtureMode): string {
  const clerkState =
    mode === "absent" ? "" : "window.Clerk = { loaded: false };";
  const finishBootstrap =
    mode === "delayed"
      ? `
    window.Clerk.loaded = true;
    document.body.innerHTML =
      '<div data-testid="app-auth-layout"><div data-testid="app-auth-v2">Ready</div></div>';`
      : "";
  return `<!doctype html>
<script>
  ${clerkState}
  fetch("/v1/client/sessions/${FIXTURE_SESSION_ID}/tokens?__clerk_testing_token=${FIXTURE_QUERY_SECRET}").then(() => {
    ${finishBootstrap}
  });
</script>`;
}

function releaseResponse(response: ServerResponse, status: number): void {
  if (response.writableEnded) {
    throw new Error("Clerk fixture response was already released");
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end("{}");
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeAllConnections();
  });
}

function restoreEnvironmentVariable(
  name: "CLERK_FAPI",
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
