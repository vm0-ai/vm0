import { command } from "ccstate";
import { DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL } from "@vm0/api-contracts/contracts/model-providers";
import { SEED_INSTRUCTIONS } from "@vm0/core/zero-seed-instructions";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, eq, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { serverSideZeroAgentCompose$ } from "./agent-compose.service";
import {
  grantOnboardingCredits,
  LIMITED_FREE_ONBOARDING_CREDITS,
  onboardingCreditsExpiresAt,
} from "./onboarding-credit-grants.service";
import { upsertOrgNoSecretModelProvider$ } from "./zero-model-provider.service";
import {
  DEFAULT_AGENT_AVATAR_URL,
  DEFAULT_AGENT_DISPLAY_NAME,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SOUND,
} from "./default-agent-profile";

const L = logger("org-limited-free-bootstrap.service");

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface EnsureOrgLimitedFreeBootstrapArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
}

type BootstrapReservation =
  | {
      readonly status: "skipped";
      readonly agentId: string;
    }
  | {
      readonly status: "reserved";
      readonly composeId: string;
    };

interface EnsureOrgLimitedFreeBootstrapResult {
  readonly bootstrapped: boolean;
  readonly agentId: string | null;
}

async function lockOrgBootstrap(
  tx: DbTransaction,
  orgId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('org_bootstrap:' || ${orgId}))`,
  );
}

async function existingDefaultAgentId(
  tx: DbTransaction,
  orgId: string,
): Promise<string | null> {
  const [orgRow] = await tx
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!orgRow?.defaultAgentId) {
    return null;
  }

  const [existing] = await tx
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.id, orgRow.defaultAgentId),
        eq(zeroAgents.orgId, orgId),
      ),
    )
    .limit(1);

  return existing?.id ?? null;
}

async function ensureBootstrapComposeRow(
  tx: DbTransaction,
  args: EnsureOrgLimitedFreeBootstrapArgs,
): Promise<string> {
  const [created] = await tx
    .insert(agentComposes)
    .values({
      userId: args.ownerUserId,
      orgId: args.orgId,
      name: DEFAULT_AGENT_NAME,
    })
    .onConflictDoNothing()
    .returning({ id: agentComposes.id });

  if (created) {
    return created.id;
  }

  const [existing] = await tx
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(agentComposes.name, DEFAULT_AGENT_NAME),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error("Expected default bootstrap compose after insert conflict");
  }

  return existing.id;
}

function isPaidTier(tier: string): boolean {
  return tier === "pro" || tier === "team";
}

async function reserveBootstrapCompose(
  tx: DbTransaction,
  args: EnsureOrgLimitedFreeBootstrapArgs,
): Promise<BootstrapReservation> {
  await lockOrgBootstrap(tx, args.orgId);

  const existingAgentId = await existingDefaultAgentId(tx, args.orgId);
  if (existingAgentId) {
    return { status: "skipped", agentId: existingAgentId };
  }

  const composeId = await ensureBootstrapComposeRow(tx, args);
  return { status: "reserved", composeId };
}

async function finalizeBootstrap(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly agentId: string;
    readonly agentName: string;
  },
): Promise<EnsureOrgLimitedFreeBootstrapResult> {
  await lockOrgBootstrap(tx, args.orgId);

  const existingAgentId = await existingDefaultAgentId(tx, args.orgId);
  if (existingAgentId) {
    return { bootstrapped: false, agentId: existingAgentId };
  }

  await tx
    .insert(zeroAgents)
    .values({
      id: args.agentId,
      orgId: args.orgId,
      name: args.agentName,
      owner: args.ownerUserId,
      displayName: DEFAULT_AGENT_DISPLAY_NAME,
      description: null,
      sound: DEFAULT_AGENT_SOUND,
      avatarUrl: DEFAULT_AGENT_AVATAR_URL,
    })
    .onConflictDoUpdate({
      target: [zeroAgents.orgId, zeroAgents.name],
      set: {
        displayName: DEFAULT_AGENT_DISPLAY_NAME,
        sound: DEFAULT_AGENT_SOUND,
        avatarUrl: DEFAULT_AGENT_AVATAR_URL,
        updatedAt: nowDate(),
      },
    });

  const [agentRow] = await tx
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, args.orgId),
        eq(zeroAgents.name, args.agentName),
      ),
    )
    .limit(1);
  if (!agentRow) {
    throw new Error("Expected zero agent after bootstrap upsert");
  }

  const [orgRow] = await tx
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  const tier = orgRow?.tier ?? "pro-suspend";

  if (isPaidTier(tier)) {
    await tx
      .update(orgMetadata)
      .set({ defaultAgentId: agentRow.id, updatedAt: nowDate() })
      .where(eq(orgMetadata.orgId, args.orgId));
    return { bootstrapped: true, agentId: agentRow.id };
  }

  await tx
    .insert(orgMetadata)
    .values({
      orgId: args.orgId,
      defaultAgentId: agentRow.id,
      tier: "limited-free-1",
      onboardingPaymentPending: false,
      updatedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: {
        defaultAgentId: agentRow.id,
        tier: "limited-free-1",
        onboardingPaymentPending: false,
        updatedAt: nowDate(),
      },
    });

  await grantOnboardingCredits(
    tx,
    args.orgId,
    LIMITED_FREE_ONBOARDING_CREDITS,
    onboardingCreditsExpiresAt(nowDate()),
  );

  return { bootstrapped: true, agentId: agentRow.id };
}

export const ensureOrgLimitedFreeBootstrap$ = command(
  async (
    { set },
    args: EnsureOrgLimitedFreeBootstrapArgs,
    signal: AbortSignal,
  ): Promise<EnsureOrgLimitedFreeBootstrapResult> => {
    const writeDb = set(writeDb$);
    const reservation = await writeDb.transaction(async (tx) => {
      return await reserveBootstrapCompose(tx, args);
    });
    signal.throwIfAborted();

    if (reservation.status === "skipped") {
      return { bootstrapped: false, agentId: reservation.agentId };
    }

    await set(
      upsertOrgNoSecretModelProvider$,
      {
        orgId: args.orgId,
        type: "vm0",
        selectedModel: DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
      },
      signal,
    );
    signal.throwIfAborted();

    const composeResult = await set(
      serverSideZeroAgentCompose$,
      {
        userId: args.ownerUserId,
        orgId: args.orgId,
        agentComposeId: reservation.composeId,
        agentName: DEFAULT_AGENT_NAME,
        instructions: SEED_INSTRUCTIONS,
      },
      signal,
    );
    signal.throwIfAborted();

    const result = await writeDb.transaction(async (tx) => {
      return await finalizeBootstrap(tx, {
        orgId: args.orgId,
        ownerUserId: args.ownerUserId,
        agentId: composeResult.composeId,
        agentName: composeResult.composeName,
      });
    });
    signal.throwIfAborted();

    if (result.bootstrapped) {
      L.debug("Org limited-free bootstrap completed", {
        orgId: args.orgId,
        agentId: result.agentId,
      });
    }

    return result;
  },
);
