import { randomUUID } from "node:crypto";

import type { RemoteAgentRunListResponse } from "@vm0/api-contracts/contracts/zero-remote-agent";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { remoteAgentHosts, remoteAgentJobs } from "@vm0/db/schema/remote-agent";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { ROUTES } from "../../route";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

async function enableRemoteAgent(orgId: string, userId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [FeatureSwitchKey.RemoteAgent]: true },
  });
}

async function seedRemoteAgentHost(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly displayName: string;
}): Promise<string> {
  const writeDb = store.set(writeDb$);
  const now = nowDate();
  const [host] = await writeDb
    .insert(remoteAgentHosts)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      displayName: args.displayName,
      tokenHash: `token-${randomUUID()}`,
      supportedBackends: ["codex"],
      status: "online",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: remoteAgentHosts.id });

  if (!host) {
    throw new Error("Failed to seed remote-agent host");
  }
  return host.id;
}

async function seedRemoteAgentJob(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly hostId?: string;
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly prompt: string;
}): Promise<string> {
  const writeDb = store.set(writeDb$);
  const now = nowDate();
  const [job] = await writeDb
    .insert(remoteAgentJobs)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      hostId: args.hostId,
      backend: args.hostId ? "codex" : null,
      prompt: args.prompt,
      status: args.status,
      output: args.status === "succeeded" ? "done" : null,
      error: args.status === "failed" ? "failed" : null,
      exitCode: args.status === "failed" ? 1 : null,
      startedAt: args.status === "queued" ? null : now,
      completedAt:
        args.status === "succeeded" || args.status === "failed" ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: remoteAgentJobs.id });

  if (!job) {
    throw new Error("Failed to seed remote-agent job");
  }
  return job.id;
}

async function cleanupFixture(fixture: OrgMembershipFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(remoteAgentJobs)
    .where(eq(remoteAgentJobs.orgId, fixture.orgId));
  await writeDb
    .delete(remoteAgentHosts)
    .where(eq(remoteAgentHosts.orgId, fixture.orgId));
  await writeDb
    .delete(userFeatureSwitches)
    .where(eq(userFeatureSwitches.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
}

async function listRuns(query = ""): Promise<{
  readonly status: number;
  readonly body: RemoteAgentRunListResponse;
}> {
  const app = createApp({ signal: context.signal, routes: ROUTES });
  const response = await app.request(`/api/zero/remote-agent/runs${query}`, {
    method: "GET",
    headers: { authorization: "Bearer clerk-session" },
  });
  const body = (await response.json()) as RemoteAgentRunListResponse;
  return { status: response.status, body };
}

describe("GET /api/zero/remote-agent/runs", () => {
  const fixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await cleanupFixture(fixture);
      }
    }
  });

  it("returns remote-agent runs for the current user", async () => {
    const fixture = await store.set(
      seedOrgMembership$,
      { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` },
      context.signal,
    );
    fixtures.push(fixture);
    await enableRemoteAgent(fixture.orgId, fixture.userId);
    const hostId = await seedRemoteAgentHost({
      orgId: fixture.orgId,
      userId: fixture.userId,
      displayName: "laptop",
    });
    const jobId = await seedRemoteAgentJob({
      orgId: fixture.orgId,
      userId: fixture.userId,
      hostId,
      status: "succeeded",
      prompt: "summarize logs",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await listRuns();

    expect(response.status).toBe(200);
    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]).toMatchObject({
      id: jobId,
      hostId,
      hostName: "laptop",
      backend: "codex",
      prompt: "summarize logs",
      status: "succeeded",
    });
    expect(response.body.runs[0]).not.toHaveProperty("output");
    expect(response.body.runs[0]).not.toHaveProperty("error");
  });

  it("filters by status and current user", async () => {
    const fixture = await store.set(
      seedOrgMembership$,
      { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` },
      context.signal,
    );
    fixtures.push(fixture);
    await enableRemoteAgent(fixture.orgId, fixture.userId);
    const failedJobId = await seedRemoteAgentJob({
      orgId: fixture.orgId,
      userId: fixture.userId,
      status: "failed",
      prompt: "failed prompt",
    });
    await seedRemoteAgentJob({
      orgId: fixture.orgId,
      userId: fixture.userId,
      status: "running",
      prompt: "running prompt",
    });
    await seedRemoteAgentJob({
      orgId: fixture.orgId,
      userId: `user_${randomUUID()}`,
      status: "failed",
      prompt: "other user prompt",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await listRuns("?status=failed");

    expect(response.status).toBe(200);
    expect(
      response.body.runs.map((run) => {
        return run.id;
      }),
    ).toStrictEqual([failedJobId]);
  });

  it("filters by host name", async () => {
    const fixture = await store.set(
      seedOrgMembership$,
      { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` },
      context.signal,
    );
    fixtures.push(fixture);
    await enableRemoteAgent(fixture.orgId, fixture.userId);
    const laptopId = await seedRemoteAgentHost({
      orgId: fixture.orgId,
      userId: fixture.userId,
      displayName: "laptop",
    });
    const desktopId = await seedRemoteAgentHost({
      orgId: fixture.orgId,
      userId: fixture.userId,
      displayName: "desktop",
    });
    const desktopJobId = await seedRemoteAgentJob({
      orgId: fixture.orgId,
      userId: fixture.userId,
      hostId: desktopId,
      status: "succeeded",
      prompt: "desktop job",
    });
    await seedRemoteAgentJob({
      orgId: fixture.orgId,
      userId: fixture.userId,
      hostId: laptopId,
      status: "succeeded",
      prompt: "laptop job",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await listRuns("?hostName=desktop");

    expect(response.status).toBe(200);
    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]?.id).toBe(desktopJobId);
    expect(response.body.runs[0]?.hostName).toBe("desktop");
  });
});
