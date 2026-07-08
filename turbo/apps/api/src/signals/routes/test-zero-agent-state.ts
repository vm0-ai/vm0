import { command } from "ccstate";
import {
  testZeroAgentStateContract,
  type TestZeroAgentStateActionBody,
} from "@vm0/api-contracts/contracts/test-zero-agent-state";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testZeroAgentStateContract.action);

type ZeroAgentStateAction<
  TAction extends TestZeroAgentStateActionBody["action"],
> = Extract<TestZeroAgentStateActionBody, { action: TAction }>;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

async function seedAgentForAction(
  db: Db,
  body: ZeroAgentStateAction<"seed-agent">,
  signal: AbortSignal,
) {
  const [compose] = await db
    .select({
      id: agentComposes.id,
      orgId: agentComposes.orgId,
      userId: agentComposes.userId,
      name: agentComposes.name,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, body.agent_id))
    .limit(1);
  signal.throwIfAborted();

  if (!compose) {
    return { status: 404 as const, body: "Agent compose not found" };
  }

  const metadata = {
    displayName: body.display_name ?? null,
    description: body.description ?? null,
    sound: body.sound ?? null,
    avatarUrl: body.avatar_url ?? null,
    visibility: body.visibility ?? "private",
  };

  await db
    .insert(zeroAgents)
    .values({
      id: compose.id,
      orgId: compose.orgId,
      owner: compose.userId,
      name: compose.name,
      ...metadata,
    })
    .onConflictDoUpdate({
      target: zeroAgents.id,
      set: {
        orgId: compose.orgId,
        owner: compose.userId,
        name: compose.name,
        ...metadata,
        updatedAt: nowDate(),
      },
    });
  signal.throwIfAborted();

  return actionOk();
}

const mutateZeroAgentState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;

    switch (body.action) {
      case "seed-agent": {
        return await seedAgentForAction(db, body, signal);
      }
    }
  },
);

export const testZeroAgentStateRoutes: readonly RouteEntry[] = [
  {
    route: testZeroAgentStateContract.action,
    handler: mutateZeroAgentState$,
  },
];
