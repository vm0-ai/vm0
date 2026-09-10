import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  cleanupRecordedClerkTestResources,
  createOrganization,
  createUser,
  generateTestEmail,
} from "./clerk-api";

interface Fixture {
  readonly directory: string;
  readonly resources: Map<string, Record<string, unknown>>;
  readonly requests: string[];
  failOrganizationCreate: boolean;
  failOrganizationDelete: boolean;
}

test("recorded cleanup deletes only created resources, organizations first, without global lists", async () => {
  await withFixture(async (fixture) => {
    fixture.resources.set("user_foreign", { id: "user_foreign" });
    fixture.resources.set("org_foreign", { id: "org_foreign" });
    const userId = await createUser(generateTestEmail("playwright"));
    const orgId = await createOrganization("Fixture", userId, "playwright");
    await cleanupRecordedClerkTestResources(["playwright"]);
    assert.equal(fixture.resources.has(userId), false);
    assert.equal(fixture.resources.has(orgId), false);
    assert.equal(fixture.resources.has("user_foreign"), true);
    assert.equal(fixture.resources.has("org_foreign"), true);
    assert.deepEqual(
      fixture.requests.filter((request) => request.startsWith("DELETE")),
      ["DELETE /v1/organizations/" + orgId, "DELETE /v1/users/" + userId],
    );
    const requestCount = fixture.requests.length;
    await cleanupRecordedClerkTestResources(["playwright"]);
    assert.equal(fixture.requests.length, requestCount);
  });
});

test("recorded cleanup verifies Clerk ownership before any deletion", async () => {
  await withFixture(async (fixture) => {
    const userId = await createUser(generateTestEmail("playwright"));
    const orgId = await createOrganization("Fixture", userId, "playwright");
    fixture.resources.set(orgId, { id: orgId, private_metadata: {} });
    await assert.rejects(
      cleanupRecordedClerkTestResources(["playwright"]),
      /ownership does not match/,
    );
    assert.equal(
      fixture.requests.some((request) => request.startsWith("DELETE")),
      false,
    );
    assert.equal(fixture.resources.has(userId), true);
  });
});

test("an ambiguous organization creation retains its user for the strict-marker sweep", async () => {
  await withFixture(async (fixture) => {
    const userId = await createUser(generateTestEmail("playwright"));
    fixture.failOrganizationCreate = true;
    await assert.rejects(
      createOrganization("Fixture", userId, "playwright"),
      /HTTP 503/,
    );
    await cleanupRecordedClerkTestResources(["playwright"]);
    assert.equal(fixture.resources.has(userId), true);
    assert.equal(
      fixture.requests.some((request) => request.startsWith("DELETE")),
      false,
    );
  });
});

test("failed organization deletion retains its user and can be retried from the record", async () => {
  await withFixture(async (fixture) => {
    const userId = await createUser(generateTestEmail("playwright"));
    await createOrganization("Fixture", userId, "playwright");
    fixture.failOrganizationDelete = true;
    await assert.rejects(
      cleanupRecordedClerkTestResources(["playwright"]),
      /HTTP 403/,
    );
    assert.equal(fixture.resources.has(userId), true);
    fixture.failOrganizationDelete = false;
    await cleanupRecordedClerkTestResources(["playwright"]);
    assert.equal(fixture.resources.has(userId), false);
  });
});

test("recorded run cleanup includes prior attempts but preserves other roles", async () => {
  await withFixture(async (fixture) => {
    process.env.GITHUB_RUN_ATTEMPT = "1";
    const oldUser = await createUser(generateTestEmail("runner"));
    await createOrganization("Prior attempt", oldUser, "runner");
    process.env.GITHUB_RUN_ATTEMPT = "2";
    const userId = await createUser(generateTestEmail("runner"));
    await createOrganization("Current attempt", userId, "runner");
    const otherUser = await createUser(generateTestEmail("paid-onboarding"));
    await createOrganization("Other role", otherUser, "paid-onboarding");
    await cleanupRecordedClerkTestResources(["runner"]);
    assert.equal(fixture.resources.has(userId), false);
    assert.equal(fixture.resources.has(oldUser), true);
    await cleanupRecordedClerkTestResources(["runner"], "run");
    assert.equal(fixture.resources.has(oldUser), false);
    assert.equal(fixture.resources.has(otherUser), true);
  });
});

test("invalid and foreign-run records fail before contacting Clerk", async () => {
  await withFixture(async (fixture) => {
    await createUser(generateTestEmail("playwright"));
    const [name] = await readdir(fixture.directory);
    assert.ok(name);
    const path = join(fixture.directory, name);
    const original: unknown = JSON.parse(await readFile(path, "utf8"));
    const requests = fixture.requests.length;
    await writeFile(path, JSON.stringify({ kind: "user", id: "../../other" }));
    await assert.rejects(
      cleanupRecordedClerkTestResources(["playwright"]),
      /Invalid Clerk resource record/,
    );
    await writeFile(path, JSON.stringify(original));
    process.env.GITHUB_RUN_ID = "8001";
    await assert.rejects(
      cleanupRecordedClerkTestResources(["playwright"]),
      /another CI scope/,
    );
    assert.equal(fixture.requests.length, requests);
  });
});

test("already deleted recorded resources are reconciled without another delete", async () => {
  await withFixture(async (fixture) => {
    const userId = await createUser(generateTestEmail("playwright"));
    await createOrganization("Fixture", userId, "playwright");
    fixture.resources.clear();
    await cleanupRecordedClerkTestResources(["playwright"]);
    assert.deepEqual(await readdir(fixture.directory), []);
    assert.equal(
      fixture.requests.some((request) => request.startsWith("DELETE")),
      false,
    );
  });
});

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "clerk-record-test-"));
  const fixture: Fixture = {
    directory,
    resources: new Map(),
    requests: [],
    failOrganizationCreate: false,
    failOrganizationDelete: false,
  };
  let userCount = 0;
  let orgCount = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    fixture.requests.push(request.method + " " + url.pathname);
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    if (request.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      if (url.pathname === "/v1/users") {
        assert.ok(Array.isArray(body.email_address));
        const id = "user_" + ++userCount;
        fixture.resources.set(id, {
          id,
          email_addresses: [{ email_address: body.email_address[0] }],
        });
        send(response, { id });
        return;
      }
      if (url.pathname === "/v1/organizations") {
        const id = "org_" + ++orgCount;
        fixture.resources.set(id, {
          id,
          private_metadata: body.private_metadata,
        });
        send(response, { id }, fixture.failOrganizationCreate ? 503 : 200);
        return;
      }
    }
    if (
      request.method === "PATCH" &&
      /\/memberships\/user_/.test(url.pathname)
    ) {
      send(response, { role: "org:admin" });
      return;
    }
    const match =
      /^\/v1\/(users|organizations)\/((?:user|org)_[a-zA-Z0-9_]+)$/.exec(
        url.pathname,
      );
    const id = match?.[2];
    if (id && request.method === "GET") {
      const resource = fixture.resources.get(id);
      send(response, resource ?? {}, resource ? 200 : 404);
      return;
    }
    if (id && request.method === "DELETE") {
      if (match?.[1] === "organizations" && fixture.failOrganizationDelete) {
        send(response, {}, 403);
      } else {
        fixture.resources.delete(id);
        send(response, {});
      }
      return;
    }
    send(
      response,
      { error: "Unexpected request; global collection is forbidden" },
      500,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const environment = {
    CLERK_API_TEST_BASE_URL: "http://127.0.0.1:" + address.port + "/v1",
    CLERK_SECRET_KEY: "fixture-secret",
    E2E_CLERK_RESOURCE_DIR: directory,
    JOB_REF: "pr-123",
    GITHUB_RUN_ID: "8000",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  try {
    await run(fixture);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

function send(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
