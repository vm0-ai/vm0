import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { test } from "node:test";

import {
  createOrganization,
  createUser,
  deleteStaleTestUsers,
  deleteUserByEmail,
} from "./clerk-api";

interface ObservedRequest {
  readonly method: string;
  readonly url: string;
}

type ClerkServerHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  requests: readonly ObservedRequest[],
) => void;

test("does not replay user creation after a transient response", async () => {
  await withClerkServer(
    (request, response, requests) => {
      const postCount = countRequests(requests, "POST", "/v1/users");
      if (request.method === "POST" && request.url === "/v1/users") {
        if (postCount === 1) {
          sendJson(response, 503, { errors: [] });
        } else {
          sendJson(response, 200, { id: "user_replayed" });
        }
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const error = await captureError(async () => {
        await createUser("single-attempt@example.com");
      });

      assert.match(
        error.message,
        /create Clerk user failed with HTTP 503 \(json\)/,
      );
      assert.equal(countRequests(requests, "POST", "/v1/users"), 1);
    },
  );
});

test("retries an idempotent membership role update", async () => {
  await withClerkServer(
    (request, response, requests) => {
      if (request.method === "POST" && request.url === "/v1/organizations") {
        sendJson(response, 200, { id: "org_test" });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === "/v1/organizations/org_test/memberships/user_test"
      ) {
        const patchCount = countRequests(
          requests,
          "PATCH",
          "/v1/organizations/org_test/memberships/user_test",
        );
        if (patchCount === 1) {
          sendJson(response, 503, { errors: [] }, { "retry-after": "0" });
        } else {
          sendJson(response, 200, { role: "org:admin" });
        }
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const organizationId = await createOrganization(
        "E2E Test Org",
        "user_test",
      );

      assert.equal(organizationId, "org_test");
      assert.equal(
        countRequests(
          requests,
          "PATCH",
          "/v1/organizations/org_test/memberships/user_test",
        ),
        2,
      );
    },
  );
});

test("retries exact lookup failures and accepts delete not found", async () => {
  const email = "cleanup@example.com";
  await withClerkServer(
    (request, response, requests) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/users?")) {
        const getCount = countRequestsStartingWith(
          requests,
          "GET",
          "/v1/users?",
        );
        if (getCount === 1) {
          request.socket.destroy();
        } else if (getCount === 2) {
          sendJson(response, 429, { errors: [] }, { "retry-after": "0" });
        } else {
          sendJson(response, 200, [
            {
              id: "user_cleanup",
              email_addresses: [{ email_address: email }],
            },
          ]);
        }
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url === "/v1/users/user_cleanup"
      ) {
        sendJson(response, 404, { errors: [] });
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      await deleteUserByEmail(email);

      assert.equal(countRequestsStartingWith(requests, "GET", "/v1/users?"), 3);
      assert.equal(
        countRequests(requests, "DELETE", "/v1/users/user_cleanup"),
        1,
      );
    },
  );
});

test("rejects non-JSON success without exposing its body", async () => {
  const responseMarker = "sensitive-external-response-marker";
  await withClerkServer(
    (request, response) => {
      if (request.method === "POST" && request.url === "/v1/users") {
        sendText(response, 200, responseMarker, "text/html; charset=utf-8");
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async () => {
      const error = await captureError(async () => {
        await createUser("invalid-response@example.com");
      });

      assert.match(
        error.message,
        /create Clerk user returned invalid JSON: HTTP 200 \(html\)/,
      );
      assert.doesNotMatch(error.message, new RegExp(responseMarker));
      assert.equal(error.cause, undefined);
    },
  );
});

test("keeps bulk stale-user deletion single-attempt and best-effort", async () => {
  const responseMarker = "bulk-delete-response-marker";
  await withClerkServer(
    (request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/users?")) {
        sendJson(response, 200, [
          {
            id: "user_stale",
            email_addresses: [
              {
                email_address: "test-job+clerk_test@e2e-browser-stale.example",
              },
            ],
          },
        ]);
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url === "/v1/users/user_stale"
      ) {
        sendText(response, 503, responseMarker, "text/html");
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...values: unknown[]): void => {
        warnings.push(values.map(String).join(" "));
      };
      try {
        await deleteStaleTestUsers();
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(
        countRequests(requests, "DELETE", "/v1/users/user_stale"),
        1,
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /HTTP 503 \(html\)/);
      assert.doesNotMatch(warnings[0] ?? "", new RegExp(responseMarker));
    },
  );
});

async function withClerkServer(
  handler: ClerkServerHandler,
  run: (requests: readonly ObservedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: ObservedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
    });
    request.resume();
    handler(request, response, requests);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Expected Clerk test server to listen on a TCP port");
  }

  const previousBaseUrl = process.env.CLERK_API_BASE_URL;
  const previousSecretKey = process.env.CLERK_SECRET_KEY;
  const previousJobRef = process.env.JOB_REF;
  process.env.CLERK_API_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.CLERK_SECRET_KEY = "sk_test_fixture";
  process.env.JOB_REF = "test-job";

  try {
    await run(requests);
  } finally {
    restoreEnvironmentVariable("CLERK_API_BASE_URL", previousBaseUrl);
    restoreEnvironmentVariable("CLERK_SECRET_KEY", previousSecretKey);
    restoreEnvironmentVariable("JOB_REF", previousJobRef);
    await closeServer(server);
  }
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function restoreEnvironmentVariable(
  name: string,
  previousValue: string | undefined,
): void {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

function countRequests(
  requests: readonly ObservedRequest[],
  method: string,
  url: string,
): number {
  return requests.filter(
    (request) => request.method === method && request.url === url,
  ).length;
}

function countRequestsStartingWith(
  requests: readonly ObservedRequest[],
  method: string,
  urlPrefix: string,
): number {
  return requests.filter(
    (request) => request.method === method && request.url.startsWith(urlPrefix),
  ).length;
}

async function captureError(action: () => Promise<void>): Promise<Error> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  return caught;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}
