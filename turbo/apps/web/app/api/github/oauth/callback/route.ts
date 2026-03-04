import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { encryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { githubInstallations } from "../../../../../src/db/schema/github-installation";
import { getInstallationAccessToken } from "../../../../../src/lib/github/github-app";
import { getPlatformUrl } from "../../../../../src/lib/url";
import { resolveDefaultAgentComposeId } from "../../../../../src/lib/agent-compose/resolve-default";

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

  // Verify HMAC signature to prevent userId spoofing.
  // The install route always signs the state when vm0UserId is present,
  // so we always verify when vm0UserId is present.
  {
    const expectedPayload = `${state.vm0UserId}:${state.composeId ?? ""}`;
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
  }

  // Resolve composeId: use state value or fall back to VM0_DEFAULT_AGENT env var
  let composeId = state.composeId;
  if (!composeId) {
    composeId = await resolveDefaultAgentComposeId();
  }

  if (!composeId) {
    return NextResponse.redirect(
      `${platformUrl}/settings?tab=integrations&error=${encodeURIComponent("Missing default agent. Please set VM0_DEFAULT_AGENT or select an agent before connecting GitHub.")}`,
    );
  }

  // Handle setup_action=request — user requested install on an org they don't admin.
  // GitHub sends no installation_id in this case. Create a pending record.
  if (setupAction === "request") {
    const targetId = url.searchParams.get("target_id");
    const targetType = url.searchParams.get("target_type") ?? "Organization";

    await globalThis.services.db.insert(githubInstallations).values({
      userId: state.vm0UserId,
      installationId: null,
      encryptedAccessToken: null,
      status: "pending",
      targetId,
      targetType,
      defaultComposeId: composeId,
    });

    return NextResponse.redirect(
      `${platformUrl}/settings?tab=integrations&pending=true`,
    );
  }

  // For install action, installation_id is required
  if (!installationId) {
    return NextResponse.redirect(
      `${platformUrl}/settings?tab=integrations&error=${encodeURIComponent("Missing installation ID from GitHub")}`,
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
    status: "active",
    defaultComposeId: composeId,
  });

  return NextResponse.redirect(`${platformUrl}/settings?tab=integrations`);
}
