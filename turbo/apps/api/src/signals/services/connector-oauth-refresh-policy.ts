import type { ConnectorReconnectReason } from "@okouai/api-contracts/contracts/connector-schemas";
import { isOAuthProviderHttpError } from "@okouai/connectors/auth-providers/oauth/error";

export function terminalOAuthRefreshReconnectReason(
  error: unknown,
): ConnectorReconnectReason | null {
  if (
    !isOAuthProviderHttpError(error) ||
    error.status !== 400 ||
    error.oauthError !== "invalid_grant" ||
    // Native adapters can normalize unrelated client errors to invalid_grant.
    error.providerErrorCode !== undefined
  ) {
    return null;
  }
  if (error.oauthErrorSubtype === "invalid_rapt") {
    return "provider_session_expired";
  }
  return error.oauthErrorSubtype ? null : "authorization_expired_or_revoked";
}

export function isTerminalOAuthRefreshState(state: {
  readonly needsReconnect: boolean;
  readonly reconnectReason: string | null;
}): boolean {
  // Reconnect replaces credentials and clears these existing account reasons.
  return (
    state.needsReconnect &&
    (state.reconnectReason === "authorization_expired_or_revoked" ||
      state.reconnectReason === "provider_session_expired")
  );
}
