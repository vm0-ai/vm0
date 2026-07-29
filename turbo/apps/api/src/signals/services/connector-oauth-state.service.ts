import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { and, eq, gt, isNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";

export type StoredOAuthState = typeof connectorOauthStates.$inferSelect;

type ConnectorOAuthStateClaimResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "usable"; readonly state: StoredOAuthState };

type ConnectorOAuthStateStatus =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "usable" };

type ConnectorOAuthAuthorizationResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "usable"; readonly authorizationUrl: string };

export async function getConnectorOAuthAuthorizationUrl(
  db: ReadonlyDb,
  args: {
    readonly state: string;
    readonly connectorSlug: ConnectorSlug;
  },
  signal: AbortSignal,
): Promise<ConnectorOAuthAuthorizationResult> {
  const [storedState] = await db
    .select({
      authorizationUrl: connectorOauthStates.authorizationUrl,
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
    storedState.type !== args.connectorSlug ||
    storedState.consumedAt ||
    storedState.expiresAt <= nowDate() ||
    !storedState.authorizationUrl
  ) {
    return { kind: "invalid" };
  }

  return {
    kind: "usable",
    authorizationUrl: storedState.authorizationUrl,
  };
}

export async function getConnectorOAuthStateStatus(
  db: Db,
  args: {
    readonly state: string;
    readonly connectorSlug: ConnectorSlug;
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
    storedState.type !== args.connectorSlug ||
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
    readonly connectorSlug: ConnectorSlug;
  },
  signal: AbortSignal,
): Promise<ConnectorOAuthStateClaimResult> {
  const claimedAt = nowDate();
  const [claimedState] = await db
    .delete(connectorOauthStates)
    .where(
      and(
        eq(connectorOauthStates.state, args.state),
        eq(connectorOauthStates.type, args.connectorSlug),
        isNull(connectorOauthStates.consumedAt),
        gt(connectorOauthStates.expiresAt, claimedAt),
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
