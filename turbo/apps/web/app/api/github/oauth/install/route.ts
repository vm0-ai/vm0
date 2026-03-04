import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getApiUrl } from "../../../../../src/lib/callback";
import { getPlatformUrl } from "../../../../../src/lib/url";
import { encryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { githubInstallations } from "../../../../../src/db/schema/github-installation";
import {
  listAppInstallations,
  getInstallationAccessToken,
} from "../../../../../src/lib/github/github-app";
import { resolveDefaultAgentComposeId } from "../../../../../src/lib/agent-compose/resolve-default";
import { linkVm0User } from "../callback/route";

/**
 * GitHub App Install Endpoint
 *
 * GET /api/github/oauth/install
 *
 * Before redirecting to GitHub, checks via the GitHub API whether the
 * app is already installed. If so, creates the local DB record and
 * user link directly (GitHub would just show its settings page and
 * never call our callback).
 *
 * The state parameter is HMAC-signed so the callback can verify
 * it was not tampered with (prevents userId spoofing).
 */
export async function GET(request: Request) {
  initServices();

  const {
    GITHUB_APP_SLUG,
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    SECRETS_ENCRYPTION_KEY,
  } = env();

  if (!GITHUB_APP_SLUG) {
    return NextResponse.json(
      { error: "GitHub App integration is not configured" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const vm0UserId = url.searchParams.get("vm0UserId");
  const composeId = url.searchParams.get("composeId");

  // If we have the App credentials, check whether the app is already
  // installed on GitHub. If it is, create/link the record locally and
  // skip the GitHub redirect entirely.
  if (GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY && vm0UserId) {
    const redirectUrl = await tryLinkExistingInstallation(
      GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY,
      SECRETS_ENCRYPTION_KEY,
      vm0UserId,
      composeId,
    );
    if (redirectUrl) {
      return NextResponse.redirect(redirectUrl);
    }
  }

  // No existing installation found — redirect to GitHub's install page.

  // Build state to pass through the installation flow
  const stateObj: {
    vm0UserId?: string;
    composeId?: string;
    sig?: string;
  } = {};
  if (vm0UserId) {
    stateObj.vm0UserId = vm0UserId;
  }
  if (composeId) {
    stateObj.composeId = composeId;
  }

  // Sign the state with HMAC to prevent tampering
  if (stateObj.vm0UserId) {
    const payload = `${stateObj.vm0UserId}:${stateObj.composeId ?? ""}`;
    stateObj.sig = createHmac("sha256", SECRETS_ENCRYPTION_KEY)
      .update(payload)
      .digest("hex");
  }

  const state =
    Object.keys(stateObj).length > 0 ? JSON.stringify(stateObj) : "";

  // GitHub App installation URL
  const installUrl = new URL(
    `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`,
  );
  if (state) {
    installUrl.searchParams.set("state", state);
  }

  // Derive redirect URI: prefer VM0_API_URL (tunnel) over request URL
  const baseUrl = getApiUrl();
  const redirectUri = `${baseUrl}/api/github/oauth/callback`;
  installUrl.searchParams.set("redirect_uri", redirectUri);

  return NextResponse.redirect(installUrl.toString());
}

/**
 * Check if the GitHub App is already installed somewhere and, if so,
 * create the local installation record + user link.
 *
 * Returns a redirect URL on success, or null if no installation was
 * found (caller should fall through to the GitHub redirect).
 */
async function tryLinkExistingInstallation(
  appId: string,
  privateKey: string,
  encryptionKey: string,
  vm0UserId: string,
  composeId: string | null,
): Promise<string | null> {
  const platformUrl = getPlatformUrl();

  let installations;
  try {
    installations = await listAppInstallations(appId, privateKey);
  } catch {
    // If the API call fails, fall through to normal install flow
    return null;
  }

  if (installations.length === 0) {
    return null;
  }

  const db = globalThis.services.db;

  // Try to find an installation that is NOT already in our DB
  for (const ghInstall of installations) {
    const ghInstallationId = String(ghInstall.id);

    const [existing] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, ghInstallationId))
      .limit(1);

    if (existing) {
      // Record exists — just create user link if needed
      await linkVm0User(db, existing.id, vm0UserId);
      return `${platformUrl}/settings?tab=integrations`;
    }
  }

  // No DB record for any installation — create one for the first
  const ghInstall = installations[0]!;
  const ghInstallationId = String(ghInstall.id);

  let resolvedComposeId = composeId;
  if (!resolvedComposeId) {
    resolvedComposeId = await resolveDefaultAgentComposeId();
  }
  if (!resolvedComposeId) {
    return `${platformUrl}/settings?tab=integrations&error=${encodeURIComponent("Missing default agent. Please set VM0_DEFAULT_AGENT or select an agent before connecting GitHub.")}`;
  }

  const { token } = await getInstallationAccessToken(
    appId,
    privateKey,
    ghInstallationId,
  );
  const encryptedAccessToken = encryptCredentialValue(token, encryptionKey);

  const adminGithubUserId =
    ghInstall.account.type === "User" ? String(ghInstall.account.id) : null;

  const [newInstall] = await db
    .insert(githubInstallations)
    .values({
      installationId: ghInstallationId,
      encryptedAccessToken,
      status: "active",
      targetType: ghInstall.account.type,
      targetId: String(ghInstall.account.id),
      targetName: ghInstall.account.login,
      adminGithubUserId,
      defaultComposeId: resolvedComposeId,
    })
    .returning({ id: githubInstallations.id });

  await linkVm0User(db, newInstall!.id, vm0UserId);

  return `${platformUrl}/settings?tab=integrations`;
}
