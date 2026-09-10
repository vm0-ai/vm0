import { isOAuthProviderHttpError } from "@okouai/connectors/auth-providers/oauth/error";

// This policy controls failure telemetry, not refresh retries or account state.
export function isExpectedOAuthRefreshFailure(args: {
  readonly error: unknown;
  readonly connectorSlug: string;
  readonly authMethod: string | undefined;
}): boolean {
  // AWS Sign-In normalizes native client errors even without a provider code.
  if (args.connectorSlug === "aws" && args.authMethod === "cli") {
    return false;
  }
  const { error } = args;
  return (
    isOAuthProviderHttpError(error) &&
    error.status === 400 &&
    error.oauthError === "invalid_grant" &&
    // Native adapters can normalize unrelated client errors to invalid_grant.
    error.providerErrorCode === undefined &&
    (!error.oauthErrorSubtype || error.oauthErrorSubtype === "invalid_rapt")
  );
}
