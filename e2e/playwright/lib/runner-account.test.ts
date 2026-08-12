import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

interface TestOwner {
  readonly jobRef: string;
  readonly generation: string;
  readonly role: string;
}

interface OrganizationRequest {
  readonly created_by: string;
  readonly name: string;
  readonly private_metadata: {
    readonly vm0CiTest: TestOwner;
  };
}

interface StoredUser {
  readonly id: string;
  readonly email: string;
}

interface StoredOrganization {
  readonly id: string;
  readonly request: OrganizationRequest;
}

interface ClerkFixtureState {
  readonly users: StoredUser[];
  readonly organizations: StoredOrganization[];
  readonly organizationRequests: OrganizationRequest[];
  readonly deletionEvents: string[];
  userCreateCount: number;
}

interface ClerkFixture {
  readonly apiUrl: string;
  readonly server: Server;
  readonly state: ClerkFixtureState;
}

test("prepares and cleans one generation of runner accounts", async () => {
  const fixture = await startClerkFixture();
  const tempDirectory = await mkdtemp(join(tmpdir(), "runner-account-test-"));
  try {
    const githubOutput = join(tempDirectory, "github-output");
    const environment = runnerEnvironment(fixture.apiUrl, {
      GITHUB_OUTPUT: githubOutput,
    });

    await runRunnerAccount("prepare", environment);

    assert.deepEqual(fixture.state.organizationRequests, [
      organizationRequest("user_1", "e2e-runner-1-pr-123", "runner"),
      organizationRequest("user_2", "e2e-runner-2-pr-123", "runner"),
      organizationRequest("user_3", "e2e-runner-3-pr-123", "runner"),
      organizationRequest("user_4", "e2e-runner-4-pr-123", "runner"),
      organizationRequest(
        "user_5",
        "e2e-runner-real-codex-pr-123",
        "runner-real-codex",
      ),
      organizationRequest(
        "user_6",
        "e2e-runner-real-claude-pr-123",
        "runner-real-claude",
      ),
      organizationRequest(
        "user_7",
        "e2e-runner-mock-claude-pr-123",
        "runner-mock-claude",
      ),
    ]);
    const outputLines = (await readFile(githubOutput, "utf8"))
      .trimEnd()
      .split("\n");
    assert.deepEqual(outputLines.slice(0, 4), [
      'runner-organization-ids=["org_1","org_2","org_3","org_4"]',
      "codex-organization-id=org_5",
      "claude-organization-id=org_6",
      "mock-claude-organization-id=org_7",
    ]);
    const runnerEmails = parseStringArrayOutput(
      outputLines[4],
      "runner-emails",
    );
    assert.equal(runnerEmails.length, 4);
    assert.equal(new Set(runnerEmails).size, 4);
    for (const email of runnerEmails) {
      assert.match(
        email,
        /^pr-123\+clerk_test\+9001-3\+runner-[0-9a-f]{8}@vm0-e2e\.ai$/,
      );
    }
    assert.deepEqual(outputLines.slice(5), [
      "codex-email=pr-123+clerk_test+9001-3+runner-real-codex@vm0-e2e.ai",
      "claude-email=pr-123+clerk_test+9001-3+runner-real-claude@vm0-e2e.ai",
      "mock-claude-email=pr-123+clerk_test+9001-3+runner-mock-claude@vm0-e2e.ai",
    ]);

    fixture.state.users.push({
      id: "user_foreign",
      email: "pr-123+clerk_test+9001-2+runner@vm0-e2e.ai",
    });
    fixture.state.organizations.push({
      id: "org_foreign",
      request: {
        created_by: "user_foreign",
        name: "foreign generation",
        private_metadata: {
          vm0CiTest: {
            jobRef: "pr-123",
            generation: "9001-2",
            role: "runner",
          },
        },
      },
    });

    await runRunnerAccount("cleanup", runnerEnvironment(fixture.apiUrl));

    assert.deepEqual(fixture.state.deletionEvents, [
      "organization:org_1",
      "organization:org_2",
      "organization:org_3",
      "organization:org_4",
      "organization:org_5",
      "organization:org_6",
      "organization:org_7",
      "user:user_1",
      "user:user_2",
      "user:user_3",
      "user:user_4",
      "user:user_5",
      "user:user_6",
      "user:user_7",
    ]);
    assert.deepEqual(fixture.state.users, [
      {
        id: "user_foreign",
        email: "pr-123+clerk_test+9001-2+runner@vm0-e2e.ai",
      },
    ]);
    assert.deepEqual(
      fixture.state.organizations.map((organization) => organization.id),
      ["org_foreign"],
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
    await closeServer(fixture.server);
  }
});

test("partial runner preparation cleans resources without outputs", async () => {
  const fixture = await startClerkFixture({ failUserCreateAt: 2 });
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "runner-account-partial-test-"),
  );
  try {
    await assert.rejects(
      runRunnerAccount(
        "prepare",
        runnerEnvironment(fixture.apiUrl, {
          GITHUB_OUTPUT: join(tempDirectory, "github-output"),
        }),
      ),
      /create Clerk user failed with HTTP 400 \(json\)/,
    );

    assert.deepEqual(fixture.state.users, []);
    assert.deepEqual(fixture.state.organizations, []);
    assert.deepEqual(fixture.state.deletionEvents, [
      "organization:org_1",
      "user:user_1",
    ]);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
    await closeServer(fixture.server);
  }
});

async function startClerkFixture(
  options: { readonly failUserCreateAt?: number } = {},
): Promise<ClerkFixture> {
  const state: ClerkFixtureState = {
    users: [],
    organizations: [],
    organizationRequests: [],
    deletionEvents: [],
    userCreateCount: 0,
  };
  const server = createServer((request, response) => {
    handleClerkRequest(request, response, state, options).catch(
      (error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      },
    );
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
    throw new Error("Expected Clerk fixture to listen on a TCP port");
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/v1`,
    server,
    state,
  };
}

async function handleClerkRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: ClerkFixtureState,
  options: { readonly failUserCreateAt?: number },
): Promise<void> {
  const path = request.url ?? "";
  const url = new URL(path, "http://clerk.test");
  if (request.method === "GET" && url.pathname === "/v1/users") {
    sendJson(
      response,
      state.users.map((user) => ({
        id: user.id,
        email_addresses: [{ email_address: user.email }],
      })),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/organizations") {
    sendJson(response, {
      data: state.organizations.map((organization) => ({
        id: organization.id,
        private_metadata: organization.request.private_metadata,
      })),
      total_count: state.organizations.length,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/users") {
    state.userCreateCount += 1;
    if (state.userCreateCount === options.failUserCreateAt) {
      sendJson(response, { errors: [] }, 400);
      return;
    }
    const email = await readUserEmail(request);
    const id = `user_${state.userCreateCount}`;
    state.users.push({ id, email });
    sendJson(response, { id });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/organizations") {
    const body = await readOrganizationRequest(request);
    const id = `org_${state.organizations.length + 1}`;
    state.organizationRequests.push(body);
    state.organizations.push({ id, request: body });
    sendJson(response, { id });
    return;
  }
  if (
    request.method === "PATCH" &&
    /^\/v1\/organizations\/org_\d+\/memberships\/user_\d+$/.test(url.pathname)
  ) {
    sendJson(response, { role: "org:admin" });
    return;
  }
  if (
    request.method === "DELETE" &&
    url.pathname.startsWith("/v1/organizations/")
  ) {
    const id = url.pathname.slice("/v1/organizations/".length);
    deleteStoredResource(
      state.organizations,
      id,
      state.deletionEvents,
      "organization",
    );
    sendJson(response, {});
    return;
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/v1/users/")) {
    const id = url.pathname.slice("/v1/users/".length);
    deleteStoredResource(state.users, id, state.deletionEvents, "user");
    sendJson(response, {});
    return;
  }
  sendJson(response, { error: "not found" }, 404);
}

function deleteStoredResource<T extends { readonly id: string }>(
  resources: T[],
  id: string,
  events: string[],
  type: "organization" | "user",
): void {
  const index = resources.findIndex((resource) => resource.id === id);
  if (index === -1) {
    return;
  }
  resources.splice(index, 1);
  events.push(`${type}:${id}`);
}

async function readUserEmail(request: IncomingMessage): Promise<string> {
  const parsed = await readJsonBody(request);
  if (!isRecord(parsed) || !Array.isArray(parsed.email_address)) {
    throw new Error("Invalid user request");
  }
  const email = parsed.email_address[0];
  if (typeof email !== "string") {
    throw new Error("Invalid user request email");
  }
  return email;
}

async function readOrganizationRequest(
  request: IncomingMessage,
): Promise<OrganizationRequest> {
  const parsed = await readJsonBody(request);
  if (
    !isRecord(parsed) ||
    typeof parsed.name !== "string" ||
    typeof parsed.created_by !== "string" ||
    !isRecord(parsed.private_metadata) ||
    !isRecord(parsed.private_metadata.vm0CiTest)
  ) {
    throw new Error("Invalid organization request");
  }
  const owner = parsed.private_metadata.vm0CiTest;
  if (
    typeof owner.jobRef !== "string" ||
    typeof owner.generation !== "string" ||
    typeof owner.role !== "string"
  ) {
    throw new Error("Invalid organization owner metadata");
  }
  return {
    name: parsed.name,
    created_by: parsed.created_by,
    private_metadata: {
      vm0CiTest: {
        jobRef: owner.jobRef,
        generation: owner.generation,
        role: owner.role,
      },
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", resolve);
    request.on("error", reject);
  });
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed;
}

function organizationRequest(
  createdBy: string,
  name: string,
  role: string,
): OrganizationRequest {
  return {
    created_by: createdBy,
    name,
    private_metadata: {
      vm0CiTest: {
        jobRef: "pr-123",
        generation: "9001-3",
        role,
      },
    },
  };
}

function runnerEnvironment(
  clerkApiUrl: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    CLERK_API_TEST_BASE_URL: clerkApiUrl,
    CLERK_SECRET_KEY: "clerk-test-secret",
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_RUN_ID: "9001",
    JOB_REF: "pr-123",
    ...extra,
  };
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

function parseStringArrayOutput(
  line: string | undefined,
  key: string,
): readonly string[] {
  const prefix = `${key}=`;
  if (!line?.startsWith(prefix)) {
    throw new Error(`Missing ${key} output`);
  }
  const parsed: unknown = JSON.parse(line.slice(prefix.length));
  if (!isStringArray(parsed)) {
    throw new Error(`Invalid ${key} output`);
  }
  return parsed;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => typeof entry === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
