import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { encryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { githubInstallations } from "../../../../../src/db/schema/github-installation";
import { getInstallationAccessToken } from "../../../../../src/lib/github/github-app";
import { getPlatformUrl } from "../../../../../src/lib/url";

/**
 * GitHub App OAuth Callback Endpoint
 *
 * GET /api/github/oauth/callback
 *
 * Handles the redirect from GitHub after a user installs the GitHub App.
 * GitHub sends `installation_id` and `setup_action` as query parameters.
 *
 * Flow:
 * 1. Parse installation_id from query params
 * 2. Verify HMAC signature on state to prevent userId spoofing
 * 3. Generate an installation access token via JWT
 * 4. Encrypt and store the token in the database
 * 5. Redirect to Platform settings page
 */

interface OAuthState {
  vm0UserId: string | null;
  composeId: string | null;
  sig: string | null;
}

function parseOAuthState(state: string | null): OAuthState {
  if (!state) {
    return { vm0UserId: null, composeId: null, sig: null };
  }

  const parsed = JSON.parse(state) as {
    vm0UserId?: string;
    composeId?: string;
    sig?: string;
  };
  return {
    vm0UserId: parsed.vm0UserId ?? null,
    composeId: parsed.composeId ?? null,
    sig: parsed.sig ?? null,
  };
}

export async function GET(request: Request) {
  initServices();

  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, SECRETS_ENCRYPTION_KEY } =
    env();

  const platformUrl = getPlatformUrl();

  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    return NextResponse.redirect(
      `${platformUrl}/settings?tab=integrations&error=${encodeURIComponent("GitHub App integration is not configured")}`,
    );
  }

  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");

  // GitHub sends setup_action=install for new installations
  // and setup_action=update for permission changes
  if (!installationId) {
    return NextResponse.redirect(
      `${platformUrl}/settings?tab=integrations&error=${encodeURIComponent("Missing installation ID from GitHub")}`,
    );
  }

  // Handle update action (permission changes) — no state needed
  if (setupAction === "update") {
    return NextResponse.redirect(`${platformUrl}/settings?tab=integrations`);
  }

  const state = parseOAuthState(url.searchParams.get("state"));

  if (!state.vm0UserId) {
    return NextResponse.redirect(
      `${platformUrl}/settings?tab=integrations&error=${encodeURIComponent("Missing user context. Please try installing again from the Platform.")}`,
    );
  }

  if (!state.composeId) {
    return NextResponse.redirect(
      `${platformUrl}/settings?tab=integrations&error=${encodeURIComponent("Missing default agent. Please select an agent before connecting GitHub.")}`,
    );
  }

  // Verify HMAC signature to prevent state tampering
  const expectedPayload = `${state.vm0UserId}:${state.composeId}`;
  const expectedSig = createHmac("sha256", SECRETS_ENCRYPTION_KEY)
    .update(expectedPayload)
    .digest("hex");

  const sigValid =
    state.sig !== null &&
    state.sig.length === expectedSig.length &&
    timingSafeEqual(Buffer.from(state.sig), Buffer.from(expectedSig));

  if (!sigValid) {
    return NextResponse.redirect(
      `${platformUrl}/settings?tab=integrations&error=${encodeURIComponent("Invalid state signature. Please try installing again from the Platform.")}`,
    );
  }

  // Check if installation already exists
  const [existing] = await globalThis.services.db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);

  if (existing) {
    // Already installed — redirect to settings
    return NextResponse.redirect(`${platformUrl}/settings?tab=integrations`);
  }

  // Get installation access token from GitHub
  const { token } = await getInstallationAccessToken(
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    installationId,
  );

  // Encrypt token before storage
  const encryptedAccessToken = encryptCredentialValue(
    token,
    SECRETS_ENCRYPTION_KEY,
  );

  // Create installation record
  await globalThis.services.db.insert(githubInstallations).values({
    userId: state.vm0UserId,
    installationId,
    encryptedAccessToken,
    defaultComposeId: state.composeId,
  });

  return NextResponse.redirect(`${platformUrl}/settings?tab=integrations`);
}
