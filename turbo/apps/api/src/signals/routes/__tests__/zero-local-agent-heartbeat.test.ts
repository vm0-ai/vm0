import { createHash, randomUUID } from "node:crypto";

import { localAgentHosts } from "@vm0/db/schema/local-agent";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { ROUTES } from "../../route";

const context = testContext();
const store = createStore();

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedLocalAgentHost(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly hostToken: string;
}): Promise<string> {
  const writeDb = store.set(writeDb$);
  const now = nowDate();
  const [host] = await writeDb
    .insert(localAgentHosts)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      displayName: "laptop",
      tokenHash: hashSecret(args.hostToken),
      supportedBackends: ["codex"],
      status: "online",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: localAgentHosts.id });

  if (!host) {
    throw new Error("Failed to seed local-agent host");
  }
  return host.id;
}

async function deleteLocalAgentHost(hostId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(localAgentHosts).where(eq(localAgentHosts.id, hostId));
}

describe("POST /api/zero/local-agent/heartbeat", () => {
  const hostIds: string[] = [];

  afterEach(async () => {
    while (hostIds.length > 0) {
      const hostId = hostIds.pop();
      if (hostId) {
        await deleteLocalAgentHost(hostId);
      }
    }
  });

  it("accepts fallback heartbeat telemetry when realtime is unavailable", async () => {
    const hostToken = `vm0_remote_host_${randomUUID()}`;
    const hostId = await seedLocalAgentHost({
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      hostToken,
    });
    hostIds.push(hostId);

    const app = createApp({ signal: context.signal, routes: ROUTES });
    const response = await app.request("/api/zero/local-agent/heartbeat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${hostToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hostName: "laptop",
        supportedBackends: ["codex"],
        realtimeConnected: false,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ ok: true, hostId });
  });
});
