import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  testOnboardingStatusStateContract,
  type TestOnboardingStatusStateActionBody,
} from "@vm0/api-contracts/contracts/test-onboarding-status-state";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testOnboardingStatusStateContract.action);

type OnboardingStatusAction<
  TAction extends TestOnboardingStatusStateActionBody["action"],
> = Extract<TestOnboardingStatusStateActionBody, { action: TAction }>;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

async function seedOrgForAction(
  db: Db,
  body: OnboardingStatusAction<"seed-org">,
  signal: AbortSignal,
) {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const composeId = body.default_agent ? randomUUID() : null;

  if (composeId) {
    await db.insert(agentComposes).values({
      id: composeId,
      userId,
      orgId,
      name: `agent-${composeId.slice(0, 8)}`,
    });
    signal.throwIfAborted();
    await db.insert(zeroAgents).values({
      id: composeId,
      orgId,
      owner: userId,
      name: `agent-${composeId.slice(0, 8)}`,
      displayName: body.default_agent?.display_name ?? null,
      description: body.default_agent?.description ?? null,
      sound: body.default_agent?.sound ?? null,
    });
    signal.throwIfAborted();
  }

  await db.insert(orgMetadata).values({
    orgId,
    defaultAgentId: composeId,
    onboardingPaymentPending: body.onboarding_payment_pending ?? false,
    onboardingComplete: body.onboarding_complete ?? true,
    ...(body.tier === undefined ? {} : { tier: body.tier }),
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      fixture: { org_id: orgId, user_id: userId, compose_id: composeId },
    },
  };
}

async function deleteOrgForAction(
  db: Db,
  body: OnboardingStatusAction<"delete-org">,
  signal: AbortSignal,
) {
  const fixture = body.fixture;
  await db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.org_id),
        eq(orgMembersMetadata.userId, fixture.user_id),
      ),
    );
  signal.throwIfAborted();
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.org_id));
  signal.throwIfAborted();

  if (fixture.compose_id) {
    await db.delete(zeroAgents).where(eq(zeroAgents.id, fixture.compose_id));
    signal.throwIfAborted();
    await db
      .delete(agentComposes)
      .where(eq(agentComposes.id, fixture.compose_id));
    signal.throwIfAborted();
  }

  return actionOk();
}

const mutateOnboardingStatusState$ = command(
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
      case "seed-org": {
        return await seedOrgForAction(db, body, signal);
      }
      case "delete-org": {
        return await deleteOrgForAction(db, body, signal);
      }
    }
  },
);

export const testOnboardingStatusStateRoutes: readonly RouteEntry[] = [
  {
    route: testOnboardingStatusStateContract.action,
    handler: mutateOnboardingStatusState$,
  },
];
