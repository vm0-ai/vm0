import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getApiUrl } from "../../../../../src/lib/infra/callback";
import { getAppUrl } from "../../../../../src/lib/zero/url";
import { encryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import {
  listAppInstallations,
  getInstallationAccessToken,
} from "../../../../../src/lib/zero/github/github-app";
import { linkVm0User } from "../callback/route";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("github:install");

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

  if (GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY && vm0UserId) {
    // Fast path: if a local installation record already exists, just
    // create the user link — no GitHub API call needed.
    const localRedirect = await tryLinkFromLocalRecord(vm0UserId);
    if (localRedirect) {
      return NextResponse.redirect(localRedirect);
    }

    // Slow path: check GitHub API for existing installations that are
    // missing from our DB (e.g. installed before we had this code).
    const apiRedirect = await tryLinkFromGitHubApi(
      GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY,
      SECRETS_ENCRYPTION_KEY,
      vm0UserId,
      composeId,
    );
    if (apiRedirect) {
      return NextResponse.redirect(apiRedirect);
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
 * Fast path: check if any installation already exists in our DB.
 * If so, just create the user link — no GitHub API call needed.
 */
async function tryLinkFromLocalRecord(
  vm0UserId: string,
): Promise<string | null> {
  const db = globalThis.services.db;
  const [existing] = await db
    .select({
      id: githubInstallations.id,
      adminGithubUserId: githubInstallations.adminGithubUserId,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.status, "active"))
    .limit(1);

  if (!existing) {
    return null;
  }

  const githubUserId = await linkVm0User(db, existing.id, vm0UserId);

  // If link failed (no GitHub OAuth connector), don't short-circuit —
  // let the user go through GitHub's install flow so the callback can
  // resolve their GitHub identity.
  if (!githubUserId) {
    return null;
  }

  // If no admin is set yet, make this user the admin
  if (!existing.adminGithubUserId) {
    await db
      .update(githubInstallations)
      .set({ adminGithubUserId: githubUserId })
      .where(eq(githubInstallations.id, existing.id));
  }

  return `${getAppUrl()}/settings?tab=integrations`;
}

/**
 * Slow path: query GitHub API for existing installations that are
 * missing from our DB (e.g. installed before we had this code, or
 * after uninstall+reinstall on GitHub's side).
 *
 * If a local DB record exists, just link the user.
 * If no DB record exists, create one from the GitHub API data.
 */
async function tryLinkFromGitHubApi(
  appId: string,
  privateKey: string,
  secretsEncryptionKey: string,
  vm0UserId: string,
  composeId: string | null,
): Promise<string | null> {
  let installations;
  try {
    installations = await listAppInstallations(appId, privateKey);
  } catch (err) {
    // Log and fall through to GitHub redirect — detection is best-effort;
    // the user can still complete the flow via GitHub's install page.
    log.warn("Failed to list app installations", { error: err });
    return null;
  }

  if (installations.length === 0) {
    return null;
  }

  const db = globalThis.services.db;
  const appUrl = getAppUrl();

  // Check if any GitHub installation is already tracked locally
  for (const ghInstall of installations) {
    const ghInstallationId = String(ghInstall.id);

    const [existing] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, ghInstallationId))
      .limit(1);

    if (existing) {
      const linked = await linkVm0User(db, existing.id, vm0UserId);
      if (linked) {
        return `${appUrl}/settings?tab=integrations`;
      }
      // Link failed — fall through to GitHub redirect
      return null;
    }
  }

  // No DB record — auto-create from the first GitHub installation.
  // This handles the case where the user uninstalled locally but the
  // app is still installed on GitHub (e.g. reinstall on same org).
  const ghInstall = installations[0]!;
  const ghInstallationId = String(ghInstall.id);

  if (!composeId) {
    return null;
  }

  const { token } = await getInstallationAccessToken(
    appId,
    privateKey,
    ghInstallationId,
  );
  const encryptedAccessToken = encryptSecretValue(token, secretsEncryptionKey);

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
      defaultComposeId: composeId,
    })
    .returning({ id: githubInstallations.id });

  if (!newInstall) {
    log.error("Failed to create GitHub installation record", {
      ghInstallationId,
    });
    return null;
  }

  await linkVm0User(db, newInstall.id, vm0UserId, adminGithubUserId);

  return `${appUrl}/settings?tab=integrations`;
}
