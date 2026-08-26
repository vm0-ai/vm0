import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("runs generation and stale cleanup through the command entry point", async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    const url = new URL(request.url ?? "", "http://clerk.test");
    if (request.method === "GET" && url.pathname === "/v1/users") {
      sendJson(response, []);
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/organizations") {
      sendJson(response, { data: [], total_count: 0 });
      return;
    }
    sendJson(response, { error: "not found" }, 404);
  });
  await listen(server);
  try {
    const environment = clerkCommandEnvironment(server);
    const generation = await runClerkCommand(
      ["cleanup-generation", "playwright,paid-onboarding"],
      environment,
    );
    assert.match(generation.stdout, /Clerk test resource cleanup/);
    assert.match(generation.stdout, /selectedOrganizations: 0/);

    const jobRef = await runClerkCommand(["cleanup-job-ref"], environment);
    assert.match(jobRef.stdout, /selectedUsers: 0/);

    const stale = await runClerkCommand(
      [
        "cleanup-stale",
        "browser,playwright,paid-onboarding",
        "--ci-older-than-hours",
        "6",
        "--staging-browser-older-than-hours",
        "8",
      ],
      { ...environment, DRY_RUN: "true" },
    );
    assert.match(stale.stdout, /dryRun: true/);

    await assert.rejects(
      runClerkCommand(
        ["cleanup-generation", "playwright,unknown"],
        environment,
      ),
      /Unknown Clerk test role: unknown/,
    );
    await assert.rejects(
      runClerkCommand(
        ["cleanup-stale", "runner,unknown", "--ci-older-than-hours", "30"],
        environment,
      ),
      /Unknown Clerk test role: unknown/,
    );

    const requestCountBeforeInvalidArguments = requestCount;
    await assert.rejects(
      runClerkCommand(
        ["cleanup-generation", "playwright", "unexpected"],
        environment,
      ),
      /Unexpected argument: unexpected/,
    );
    await assert.rejects(
      runClerkCommand(
        [
          "cleanup-stale",
          "runner",
          "--ci-older-than-hours",
          "30",
          "--staging-browser-older-than-hours",
          "8",
          "unexpected",
        ],
        environment,
      ),
      /Unexpected argument: unexpected/,
    );
    await assert.rejects(
      runClerkCommand(
        ["cleanup-stale", "runner", "--ci-older-than-hours", "30"],
        environment,
      ),
      /cleanup-stale requires/,
    );
    assert.equal(requestCount, requestCountBeforeInvalidArguments);
  } finally {
    await closeServer(server);
  }
});

function clerkCommandEnvironment(
  server: Server,
): Readonly<Record<string, string>> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected Clerk fixture to listen on a TCP port");
  }
  return {
    CLERK_API_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    CLERK_SECRET_KEY: "clerk-test-secret",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "7000",
    JOB_REF: "pr-321",
  };
}

async function runClerkCommand(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await execFileAsync(
    process.execPath,
    ["--import", "tsx", "playwright/clerk-test-resources.ts", ...arguments_],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
    },
  );
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
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

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
