import type { OAuthGrantConnectorType } from "@vm0/connectors/connectors";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { and, eq, gt, isNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

export type StoredOAuthState = typeof connectorOauthStates.$inferSelect;

type ConnectorOAuthStateClaimResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "usable"; readonly state: StoredOAuthState };

type ConnectorOAuthStateStatus =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "usable" };

export async function getConnectorOAuthStateStatus(
  db: Db,
  args: {
    readonly state: string;
    readonly connectorType: OAuthGrantConnectorType;
  },
  signal: AbortSignal,
): Promise<ConnectorOAuthStateStatus> {
  const [storedState] = await db
    .select({
      type: connectorOauthStates.type,
      consumedAt: connectorOauthStates.consumedAt,
      expiresAt: connectorOauthStates.expiresAt,
    })
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, args.state))
    .limit(1);
  signal.throwIfAborted();

  if (!storedState) {
    return { kind: "missing" };
  }

  if (
    storedState.type !== args.connectorType ||
    storedState.consumedAt ||
    storedState.expiresAt <= nowDate()
  ) {
    return { kind: "invalid" };
  }

  return { kind: "usable" };
}

export async function claimConnectorOAuthState(
  db: Db,
  args: {
    readonly state: string;
    readonly connectorType: OAuthGrantConnectorType;
  },
  signal: AbortSignal,
): Promise<ConnectorOAuthStateClaimResult> {
  const consumedAt = nowDate();
  const [claimedState] = await db
    .update(connectorOauthStates)
    .set({ consumedAt })
    .where(
      and(
        eq(connectorOauthStates.state, args.state),
        eq(connectorOauthStates.type, args.connectorType),
        isNull(connectorOauthStates.consumedAt),
        gt(connectorOauthStates.expiresAt, consumedAt),
      ),
    )
    .returning();
  signal.throwIfAborted();

  if (claimedState) {
    return { kind: "usable", state: claimedState };
  }

  const [existingState] = await db
    .select({ id: connectorOauthStates.id })
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, args.state))
    .limit(1);
  signal.throwIfAborted();

  return existingState ? { kind: "invalid" } : { kind: "missing" };
}
