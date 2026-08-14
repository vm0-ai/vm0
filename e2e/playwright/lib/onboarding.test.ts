import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { ensureRunnerOrganizationReady } from "./onboarding";

test("synchronizes runner organization onboarding through the public status route", async () => {
  const requests: Array<{
    readonly authorization: string | null;
    readonly bypass: string | null;
    readonly method: string | undefined;
    readonly url: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization ?? null,
      bypass: headerValue(request.headers["x-vercel-protection-bypass"]),
      method: request.method,
      url: request.url,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        needsOnboarding: true,
        onboardingComplete: false,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "agent_default",
        defaultAgentMetadata: null,
      }),
    );
  });

  await listen(server);
  try {
    const address = server.address();
    assert(address && typeof address === "object");

    await ensureRunnerOrganizationReady({
      apiUrl: `http://127.0.0.1:${address.port}`,
      clerkSessionToken: "clerk-session-token",
      vercelAutomationBypassSecret: "preview-bypass",
    });

    assert.deepEqual(requests, [
      {
        authorization: "Bearer clerk-session-token",
        bypass: "preview-bypass",
        method: "GET",
        url: "/api/okou/onboarding/status",
      },
    ]);
  } finally {
    await close(server);
  }
});

test("rejects a runner organization that remains uninitialized", async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        needsOnboarding: true,
        onboardingComplete: false,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: false,
        defaultAgentId: null,
        defaultAgentMetadata: null,
      }),
    );
  });

  await listen(server);
  try {
    const address = server.address();
    assert(address && typeof address === "object");

    await assert.rejects(
      ensureRunnerOrganizationReady({
        apiUrl: `http://127.0.0.1:${address.port}`,
        clerkSessionToken: "clerk-session-token",
      }),
      /did not return a ready admin organization/u,
    );
    assert.equal(requestCount, 1);
  } finally {
    await close(server);
  }
});

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
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

function headerValue(
  value: string | readonly string[] | undefined,
): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.[0] ?? null;
}
