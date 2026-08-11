import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

interface OrganizationRequest {
  readonly created_by: string;
  readonly name: string;
}

test("prepares and cleans up three independent runner organizations", async () => {
  const organizationRequests: OrganizationRequest[] = [];
  const deletedOrganizationPaths: string[] = [];
  let userSequence = 0;
  let organizationSequence = 0;
  const server = createServer((request, response) => {
    handleClerkRequest(request, response, {
      createOrganization: (body) => {
        organizationRequests.push(body);
        organizationSequence += 1;
        return `org_${organizationSequence}`;
      },
      createUser: () => {
        userSequence += 1;
        return `user_${userSequence}`;
      },
      deleteOrganization: (path) => {
        deletedOrganizationPaths.push(path);
      },
    }).catch((error: unknown) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const tempDirectory = await mkdtemp(join(tmpdir(), "runner-account-test-"));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const clerkApiUrl = `http://127.0.0.1:${address.port}/v1`;
    const githubOutput = join(tempDirectory, "github-output");

    await runRunnerAccount("prepare", {
      CLERK_API_TEST_BASE_URL: clerkApiUrl,
      CLERK_SECRET_KEY: "clerk-test-secret",
      GITHUB_OUTPUT: githubOutput,
      JOB_REF: "pr-123",
    });

    assert.deepEqual(organizationRequests, [
      { created_by: "user_1", name: "e2e-runner-pr-123" },
      {
        created_by: "user_2",
        name: "e2e-runner-real-codex-pr-123",
      },
      {
        created_by: "user_3",
        name: "e2e-runner-real-claude-pr-123",
      },
    ]);
    assert.equal(
      await readFile(githubOutput, "utf8"),
      [
        "runner-organization-id=org_1",
        "codex-organization-id=org_2",
        "claude-organization-id=org_3",
        "runner-email=pr-123+clerk_test+runner@vm0-e2e.ai",
        "codex-email=pr-123+clerk_test+runner-real-codex@vm0-e2e.ai",
        "claude-email=pr-123+clerk_test+runner-real-claude@vm0-e2e.ai",
        "",
      ].join("\n"),
    );

    await runRunnerAccount("cleanup", {
      CLERK_API_TEST_BASE_URL: clerkApiUrl,
      CLERK_SECRET_KEY: "clerk-test-secret",
      E2E_RUNNER_ORGANIZATION_ID: "org_1",
      E2E_RUNNER_CODEX_ORGANIZATION_ID: "org_2",
      E2E_RUNNER_CLAUDE_ORGANIZATION_ID: "org_3",
      JOB_REF: "pr-123",
    });
    assert.deepEqual(deletedOrganizationPaths, [
      "/v1/organizations/org_1",
      "/v1/organizations/org_2",
      "/v1/organizations/org_3",
    ]);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
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

interface ClerkRequestHandlers {
  readonly createOrganization: (body: OrganizationRequest) => string;
  readonly createUser: () => string;
  readonly deleteOrganization: (path: string) => void;
}

async function handleClerkRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: ClerkRequestHandlers,
): Promise<void> {
  const path = request.url ?? "";
  if (request.method === "GET" && path.startsWith("/v1/users?")) {
    sendJson(response, []);
    return;
  }
  if (request.method === "POST" && path === "/v1/users") {
    sendJson(response, { id: handlers.createUser() });
    return;
  }
  if (request.method === "POST" && path === "/v1/organizations") {
    const body = await readOrganizationRequest(request);
    sendJson(response, { id: handlers.createOrganization(body) });
    return;
  }
  if (
    request.method === "PATCH" &&
    /^\/v1\/organizations\/org_\d+\/memberships\/user_\d+$/.test(path)
  ) {
    sendJson(response, { role: "org:admin" });
    return;
  }
  if (
    request.method === "DELETE" &&
    /^\/v1\/organizations\/org_\d+$/.test(path)
  ) {
    handlers.deleteOrganization(path);
    sendJson(response, {});
    return;
  }
  sendJson(response, { error: "not found" }, 404);
}

async function readOrganizationRequest(
  request: IncomingMessage,
): Promise<OrganizationRequest> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", resolve);
    request.on("error", reject);
  });
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    typeof parsed.name !== "string" ||
    !("created_by" in parsed) ||
    typeof parsed.created_by !== "string"
  ) {
    throw new Error("Invalid organization request");
  }
  return { name: parsed.name, created_by: parsed.created_by };
}

async function runRunnerAccount(
  command: "prepare" | "cleanup",
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "playwright/runner-account.ts", command],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
    },
  );
}

function sendJson(response: ServerResponse, body: object, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
