import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { ensureOnboardingBootstrap } from "./onboarding";

test("waits for the authenticated onboarding bootstrap", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/zero/onboarding/status");
    assert.equal(request.headers.authorization, "Bearer clerk-session-token");
    assert.equal(request.headers["cf-access-client-id"], "access-client-id");
    assert.equal(
      request.headers["cf-access-client-secret"],
      "access-client-secret",
    );
    assert.equal(
      request.headers["x-vercel-protection-bypass"],
      "preview-bypass",
    );
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        defaultAgentId: "agent-default",
        hasDefaultAgent: true,
        hasOrg: true,
        isAdmin: true,
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");

    await ensureOnboardingBootstrap({
      apiPreviewHeaders: {
        "cf-access-client-id": "access-client-id",
        "cf-access-client-secret": "access-client-secret",
        "x-vercel-protection-bypass": "preview-bypass",
      },
      apiUrl: `http://127.0.0.1:${address.port}`,
      clerkSessionToken: "clerk-session-token",
    });
  } finally {
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
});
