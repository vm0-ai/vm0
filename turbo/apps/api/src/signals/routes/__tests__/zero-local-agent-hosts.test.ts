import { createHash, randomUUID } from "node:crypto";

import { localAgentHosts } from "@vm0/db/schema/local-agent";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { ROUTES } from "../../route";

const context = testContext();
const store = createStore();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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
      displayName: `host-${randomUUID()}`,
      tokenHash: hashToken(args.hostToken),
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

async function closeHost(hostToken: string): Promise<Response> {
  const app = createApp({ signal: context.signal, routes: ROUTES });
  return await app.request("/api/zero/local-agent/hosts/close", {
    method: "POST",
    headers: { authorization: `Bearer ${hostToken}` },
  });
}

describe("POST /api/zero/local-agent/hosts/close", () => {
  const orgIds: string[] = [];

  afterEach(async () => {
    const writeDb = store.set(writeDb$);
    while (orgIds.length > 0) {
      const orgId = orgIds.pop();
      if (orgId) {
        await writeDb
          .delete(localAgentHosts)
          .where(eq(localAgentHosts.orgId, orgId));
      }
    }
  });

  it("marks the authenticated local-agent host closed", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const hostToken = `vm0_remote_host_${randomUUID()}`;
    orgIds.push(orgId);
    const hostId = await seedLocalAgentHost({ orgId, userId, hostToken });

    const response = await closeHost(hostToken);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ ok: true });

    const writeDb = store.set(writeDb$);
    const [host] = await writeDb
      .select({ status: localAgentHosts.status })
      .from(localAgentHosts)
      .where(eq(localAgentHosts.id, hostId));
    expect(host?.status).toBe("closed");
  });

  it("rejects invalid local-agent host tokens", async () => {
    const response = await closeHost("invalid-token");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });
});
