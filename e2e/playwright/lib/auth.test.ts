import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { chromium } from "@playwright/test";

import {
  getCurrentClerkSessionToken,
  signInWithLoadedClerkTestingHelper,
  type ClerkSessionTokenCache,
  withLoadedClerkTestingPage,
} from "./auth";

type ClerkFixtureMode =
  | "absent"
  | "incomplete"
  | "loaded"
  | "loaded-email-code"
  | "loaded-without-token"
  | "recover";

interface ClerkFixture {
  readonly appUrl: string;
  readonly documentRequestCount: () => number;
  readonly frontendRequestCount: () => number;
}

const FIXTURE_QUERY_SECRET = "do-not-log-capability";

test("isolates runner Clerk bootstrap recovery before side effects", async (context) => {
  const browser = await chromium.launch();
  try {
    await context.test(
      "retries a stalled bootstrap in a clean context",
      async () => {
        await withClerkFixture("recover", async (fixture) => {
          let callbackCount = 0;
          const state = await withLoadedClerkTestingPage(
            browser,
            {
              appUrl: fixture.appUrl,
              bootstrapTimeoutsMs: [250, 1_000],
              contextOptions: {},
            },
            async (page) => {
              callbackCount += 1;
              return page.evaluate(() => {
                return {
                  hasLoadedClerk: Boolean(window.Clerk?.loaded),
                  poison: localStorage.getItem("clerk-bootstrap-poison"),
                };
              });
            },
          );

          assert.deepEqual(state, { hasLoadedClerk: true, poison: null });
          assert.equal(callbackCount, 1);
          assert.equal(fixture.documentRequestCount(), 2);
          assert.equal(fixture.frontendRequestCount(), 2);
        });
      },
    );

    await context.test("reports a sanitized terminal timeout", async () => {
      await withClerkFixture("incomplete", async (fixture) => {
        await assert.rejects(
          withLoadedClerkTestingPage(
            browser,
            {
              appUrl: fixture.appUrl,
              bootstrapTimeoutsMs: [250, 250],
              contextOptions: {},
            },
            async () => {
              throw new Error("callback must not run");
            },
          ),
          (error: unknown) => {
            assert(error instanceof Error);
            assert.match(
              error.message,
              /Clerk bootstrap timed out after 2 attempts: ClerkJS present but not loaded; last Clerk request: GET \/v1\/client -> 503/u,
            );
            assert.doesNotMatch(
              error.message,
              new RegExp(FIXTURE_QUERY_SECRET),
            );
            return true;
          },
        );
        assert.equal(fixture.documentRequestCount(), 2);
        assert.equal(fixture.frontendRequestCount(), 2);
      });
    });

    await context.test("distinguishes an absent ClerkJS global", async () => {
      await withClerkFixture("absent", async (fixture) => {
        await assert.rejects(
          withLoadedClerkTestingPage(
            browser,
            {
              appUrl: fixture.appUrl,
              bootstrapTimeoutsMs: [250, 250],
              contextOptions: {},
            },
            async () => {
              throw new Error("callback must not run");
            },
          ),
          (error: unknown) => {
            assert(error instanceof Error);
            assert.match(
              error.message,
              /Clerk bootstrap timed out after 2 attempts: ClerkJS absent; last Clerk request: GET \/v1\/client -> 200/u,
            );
            return true;
          },
        );
        assert.equal(fixture.documentRequestCount(), 2);
      });
    });

    await context.test("does not retry errors after bootstrap", async () => {
      await withClerkFixture("loaded", async (fixture) => {
        const callbackError = new Error("post-bootstrap side effect failed");
        await assert.rejects(
          withLoadedClerkTestingPage(
            browser,
            {
              appUrl: fixture.appUrl,
              bootstrapTimeoutsMs: [250, 1_000],
              contextOptions: {},
            },
            async () => {
              throw callbackError;
            },
          ),
          (error: unknown) => error === callbackError,
        );
        assert.equal(fixture.documentRequestCount(), 1);
        assert.equal(fixture.frontendRequestCount(), 0);
      });
    });
  } finally {
    await browser.close();
  }
});

test("keeps Clerk session tokens current across repeated observers", async (context) => {
  const browser = await chromium.launch();
  try {
    await context.test(
      "reuses recent tokens and refreshes aged tokens",
      async () => {
        await withClerkFixture("loaded", async (fixture) => {
          await withLoadedClerkTestingPage(
            browser,
            {
              appUrl: fixture.appUrl,
              contextOptions: {},
            },
            async (page) => {
              const cache: ClerkSessionTokenCache = {
                refreshedAt: Date.now(),
                token: "seed-token",
              };
              const options = {
                activeOrganizationId: "org_fixture",
                reuseMs: 30_000,
              };

              assert.equal(
                await getCurrentClerkSessionToken(page, cache, options),
                "seed-token",
              );

              cache.refreshedAt = Date.now() - options.reuseMs;
              assert.equal(
                await getCurrentClerkSessionToken(page, cache, options),
                "fixture-token-1",
              );
              assert.equal(
                await getCurrentClerkSessionToken(page, cache, options),
                "fixture-token-1",
              );
            },
          );
        });
      },
    );

    await context.test("surfaces a failed token refresh", async () => {
      await withClerkFixture("loaded-without-token", async (fixture) => {
        await assert.rejects(
          withLoadedClerkTestingPage(
            browser,
            {
              appUrl: fixture.appUrl,
              contextOptions: {},
            },
            async (page) => {
              const cache: ClerkSessionTokenCache = {
                refreshedAt: 0,
                token: "expired-token",
              };
              await getCurrentClerkSessionToken(page, cache, {
                activeOrganizationId: "org_fixture",
                reuseMs: 30_000,
              });
            },
          ),
          /Clerk session token unavailable after refresh/u,
        );
      });
    });
  } finally {
    await browser.close();
  }
});

test("signs testing emails in through Clerk's email-code strategy", async () => {
  const browser = await chromium.launch();
  try {
    await withClerkFixture("loaded-email-code", async (fixture) => {
      await withLoadedClerkTestingPage(
        browser,
        {
          appUrl: fixture.appUrl,
          contextOptions: {},
        },
        async (page) => {
          const token = await signInWithLoadedClerkTestingHelper(
            page,
            "fixture+clerk_test@example.com",
            fixture.appUrl,
            { preserveAppPage: true },
          );
          const signInState = await page.evaluate(() => {
            const fixtureWindow = window as unknown as {
              __clerkEmailCodeState: {
                attemptedCode: string | null;
                identifier: string | null;
                preparedEmailAddressId: string | null;
                sessionId: string | null;
              };
            };
            return fixtureWindow.__clerkEmailCodeState;
          });

          assert.equal(token, "fixture-token-1");
          assert.deepEqual(signInState, {
            attemptedCode: "424242",
            identifier: "fixture+clerk_test@example.com",
            preparedEmailAddressId: "email_fixture",
            sessionId: "session_fixture",
          });
        },
      );
    });
  } finally {
    await browser.close();
  }
});

async function withClerkFixture<Result>(
  mode: ClerkFixtureMode,
  use: (fixture: ClerkFixture) => Promise<Result>,
): Promise<Result> {
  let documentRequests = 0;
  let frontendRequests = 0;
  const server = createServer((request, response) => {
    const requestUrl = request.url;
    if (!requestUrl) {
      throw new Error("Clerk fixture request URL is required");
    }
    const pathname = new URL(requestUrl, "http://clerk.fixture").pathname;
    if (pathname === "/_/skeleton") {
      documentRequests += 1;
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(clerkFixtureDocument(mode, documentRequests));
      return;
    }
    if (pathname === "/v1/client") {
      frontendRequests += 1;
      if (mode === "recover" && frontendRequests === 1) {
        return;
      }
      response.writeHead(mode === "incomplete" ? 503 : 200, {
        "Content-Type": "application/json",
      });
      response.end("{}");
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await listen(server);
  const address = server.address();
  assert(address && typeof address === "object");
  const previousFrontendApi = process.env.CLERK_FAPI;
  const previousTestingToken = process.env.CLERK_TESTING_TOKEN;
  process.env.CLERK_FAPI = `127.0.0.1:${address.port}`;
  process.env.CLERK_TESTING_TOKEN = "fixture-testing-token";
  try {
    return await use({
      appUrl: `http://127.0.0.1:${address.port}`,
      documentRequestCount: () => documentRequests,
      frontendRequestCount: () => frontendRequests,
    });
  } finally {
    restoreEnvironmentVariable("CLERK_FAPI", previousFrontendApi);
    restoreEnvironmentVariable("CLERK_TESTING_TOKEN", previousTestingToken);
    await close(server);
  }
}

function clerkFixtureDocument(
  mode: ClerkFixtureMode,
  documentRequest: number,
): string {
  if (
    mode === "loaded" ||
    mode === "loaded-email-code" ||
    mode === "loaded-without-token"
  ) {
    const tokenResult =
      mode === "loaded-without-token"
        ? "null"
        : "`fixture-token-${++tokenRequests}`";
    const sessionFixture =
      mode === "loaded-email-code"
        ? "null"
        : `{ getToken: async () => ${tokenResult} }`;
    const emailCodeFixture =
      mode === "loaded-email-code"
        ? `
  window.__clerkEmailCodeState = {
    attemptedCode: null,
    identifier: null,
    preparedEmailAddressId: null,
    sessionId: null,
  };
  const signIn = {
    create: async ({ identifier }) => {
      window.__clerkEmailCodeState.identifier = identifier;
      return {
        supportedFirstFactors: [
          { strategy: "email_code", emailAddressId: "email_fixture" },
        ],
      };
    },
    prepareFirstFactor: async ({ emailAddressId }) => {
      window.__clerkEmailCodeState.preparedEmailAddressId = emailAddressId;
    },
    attemptFirstFactor: async ({ code }) => {
      window.__clerkEmailCodeState.attemptedCode = code;
      return { status: "complete", createdSessionId: "session_fixture" };
    },
  };
  const setActive = async ({ session }) => {
    window.__clerkEmailCodeState.sessionId = session;
    window.Clerk.session = { getToken: async () => ${tokenResult} };
    window.Clerk.user = { id: "user_fixture" };
  };`
        : "";
    return `<!doctype html>
<script>
  let tokenRequests = 0;
  ${emailCodeFixture}
  window.Clerk = {
    client: ${mode === "loaded-email-code" ? "{ signIn }" : "undefined"},
    loaded: true,
    organization: { id: "org_fixture" },
    session: ${sessionFixture},
    user: null,
    setActive: ${mode === "loaded-email-code" ? "setActive" : "undefined"},
  };
</script>`;
  }
  if (mode === "absent") {
    return `<!doctype html><script>fetch("/v1/client?__clerk_testing_token=${FIXTURE_QUERY_SECRET}");</script>`;
  }
  const poisonFirstContext =
    mode === "recover" && documentRequest === 1
      ? `localStorage.setItem("clerk-bootstrap-poison", "true");`
      : "";
  const finishBootstrap =
    mode === "recover"
      ? `if (!localStorage.getItem("clerk-bootstrap-poison")) { window.Clerk.loaded = true; }`
      : "";
  return `<!doctype html>
<script>
  window.Clerk = { loaded: false };
  ${poisonFirstContext}
  fetch("/v1/client?__clerk_testing_token=${FIXTURE_QUERY_SECRET}").then(() => {
    ${finishBootstrap}
  });
</script>`;
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
  name: "CLERK_FAPI" | "CLERK_TESTING_TOKEN",
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
