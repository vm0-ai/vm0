import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { issueCliToken } from "./cli-token";

interface ObservedRequest {
  readonly authorization: string | null;
  readonly bypass: string | null;
  readonly method: string | undefined;
  readonly url: string | undefined;
}

test("issues a CLI token through the public device authorization flow", async () => {
  const requests: ObservedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization ?? null,
      bypass: headerValue(request.headers["x-vercel-protection-bypass"]),
      method: request.method,
      url: request.url,
    });

    switch (request.url) {
      case "/api/cli/auth/device": {
        sendJson(response, { device_code: "ABCD-EFGH" });
        break;
      }
      case "/api/cli/auth/approve": {
        sendJson(response, { success: true });
        break;
      }
      case "/api/cli/auth/token": {
        sendJson(response, {
          access_token: "runner-cli-token",
          token_type: "Bearer",
          expires_in: 7_776_000,
        });
        break;
      }
      default: {
        sendJson(response, { error: "not found" }, 404);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");

    const token = await issueCliToken({
      apiUrl: `http://127.0.0.1:${address.port}`,
      clerkSessionToken: "clerk-session-token",
      vercelAutomationBypassSecret: "preview-bypass",
    });

    assert.equal(token, "runner-cli-token");
    assert.deepEqual(requests, [
      {
        authorization: null,
        bypass: "preview-bypass",
        method: "POST",
        url: "/api/cli/auth/device",
      },
      {
        authorization: "Bearer clerk-session-token",
        bypass: "preview-bypass",
        method: "POST",
        url: "/api/cli/auth/approve",
      },
      {
        authorization: null,
        bypass: "preview-bypass",
        method: "POST",
        url: "/api/cli/auth/token",
      },
    ]);
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

function sendJson(
  response: import("node:http").ServerResponse,
  body: object,
  status = 200,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function headerValue(
  value: string | readonly string[] | undefined,
): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.[0] ?? null;
}
