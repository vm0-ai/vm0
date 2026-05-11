import { and, count, eq, isNull, or } from "drizzle-orm";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import type { ZeroAgentVisibility } from "@vm0/db/schema/zero-agent";
import type { AuthContext } from "../auth/get-auth-context";
import type { Database } from "../../types/global";
import { loadFeatureSwitchOverrides } from "./user/feature-switches-service";

export const PUBLIC_AGENT_LIMIT = 7;

export function isPrivateAgent(agent: {
  visibility: ZeroAgentVisibility | null | undefined;
}): boolean {
  return agent.visibility === "private";
}

export function visibleZeroAgentCondition(userId: string) {
  return or(eq(zeroAgents.visibility, "public"), eq(zeroAgents.owner, userId));
}

export function visibleJoinedZeroAgentCondition(userId: string) {
  return or(
    isNull(zeroAgents.id),
    eq(zeroAgents.visibility, "public"),
    eq(zeroAgents.owner, userId),
  );
}

export async function assertPrivateAgentsFeatureEnabled(
  authCtx: AuthContext,
  orgId: string,
): Promise<{
  status: 403;
  body: { error: { message: string; code: string } };
} | null> {
  const overrides = await loadFeatureSwitchOverrides(orgId, authCtx.userId);
  const enabled = isFeatureEnabled(FeatureSwitchKey.PrivateAgents, {
    userId: authCtx.userId,
    email: authCtx.sessionClaims?.email,
    orgId,
    overrides,
  });
  if (enabled) return null;
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Private agents are not available for this account",
        code: "FORBIDDEN",
      },
    },
  };
}

export async function countPublicAgents(
  orgId: string,
  db: Database = globalThis.services.db,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(zeroAgents)
    .where(
      and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.visibility, "public")),
    );
  return row?.value ?? 0;
}
