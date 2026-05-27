import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

interface DefaultAgentValues {
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly sound?: string | null;
}

interface OnboardingSeedValues {
  readonly defaultAgent?: DefaultAgentValues;
  readonly onboardingPaymentPending?: boolean;
}

export interface OnboardingStatusFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string | null;
}

export const seedOnboardingStatusOrg$ = command(
  async (
    { set },
    values: OnboardingSeedValues,
    signal: AbortSignal,
  ): Promise<OnboardingStatusFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);
    const composeId = values.defaultAgent ? randomUUID() : null;

    if (composeId) {
      await writeDb.insert(agentComposes).values({
        id: composeId,
        userId,
        orgId,
        name: `agent-${composeId.slice(0, 8)}`,
      });
      signal.throwIfAborted();
      await writeDb.insert(zeroAgents).values({
        id: composeId,
        orgId,
        owner: userId,
        name: `agent-${composeId.slice(0, 8)}`,
        displayName: values.defaultAgent?.displayName ?? null,
        description: values.defaultAgent?.description ?? null,
        sound: values.defaultAgent?.sound ?? null,
      });
      signal.throwIfAborted();
    }

    await writeDb.insert(orgMetadata).values({
      orgId,
      defaultAgentId: composeId,
      onboardingPaymentPending: values.onboardingPaymentPending ?? false,
    });
    signal.throwIfAborted();

    return { orgId, userId, composeId };
  },
);

// Seeds an org whose `default_agent_id` points to an `agent_composes` row that
// has no matching `zero_agents` row — the partial-onboarding state where the
// admin should re-enter full onboarding.
export const seedOrphanDefaultAgent$ = command(
  async (
    { set },
    _: void,
    signal: AbortSignal,
  ): Promise<OnboardingStatusFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const composeId = randomUUID();
    const writeDb = set(writeDb$);

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId,
      orgId,
      name: `agent-${composeId.slice(0, 8)}`,
    });
    signal.throwIfAborted();

    await writeDb.insert(orgMetadata).values({
      orgId,
      defaultAgentId: composeId,
    });
    signal.throwIfAborted();

    return { orgId, userId, composeId };
  },
);

// Seeds an org whose `default_agent_id` points to a fully-formed compose owned
// by a *different* org. The INNER JOIN filter on `agent_composes.orgId` must
// reject the row so the target org appears to have no default agent.
export const seedCrossOrgDefaultAgent$ = command(
  async (
    { set },
    _: void,
    signal: AbortSignal,
  ): Promise<OnboardingStatusFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;
    const otherUserId = `user_${randomUUID()}`;
    const composeId = randomUUID();
    const writeDb = set(writeDb$);

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId: otherUserId,
      orgId: otherOrgId,
      name: `agent-${composeId.slice(0, 8)}`,
    });
    signal.throwIfAborted();
    await writeDb.insert(zeroAgents).values({
      id: composeId,
      orgId: otherOrgId,
      owner: otherUserId,
      name: `agent-${composeId.slice(0, 8)}`,
      displayName: null,
      description: null,
      sound: null,
    });
    signal.throwIfAborted();

    await writeDb.insert(orgMetadata).values({
      orgId,
      defaultAgentId: composeId,
    });
    signal.throwIfAborted();

    return { orgId, userId, composeId };
  },
);

export const deleteOnboardingStatusOrg$ = command(
  async (
    { set },
    fixture: OnboardingStatusFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();

    if (fixture.composeId) {
      await writeDb
        .delete(zeroAgents)
        .where(eq(zeroAgents.id, fixture.composeId));
      signal.throwIfAborted();
      await writeDb
        .delete(agentComposes)
        .where(eq(agentComposes.id, fixture.composeId));
      signal.throwIfAborted();
    }
  },
);
