import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { encryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { connectors } from "@vm0/db/schema/connector";
import {
  getInstallationAccessToken,
  getInstallationInfo,
} from "../../../../../src/lib/zero/github/github-app";
import { getAppUrl } from "../../../../../src/lib/zero/url";
import { resolveDefaultAgentComposeId } from "../../../../../src/lib/infra/agent-compose/resolve-default";

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
 * 3. Create/reuse installation record (org-level, not per-user)
 * 4. Create github_user_links record if vm0UserId is present
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

  const appUrl = getAppUrl();

  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    return NextResponse.redirect(
      `${appUrl}/works?error=${encodeURIComponent("GitHub App integration is not configured")}`,
    );
  }

  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");

  // Handle update action (permission changes) — no state needed
  if (setupAction === "update") {
    return NextResponse.redirect(`${appUrl}/works`);
  }

  let state: OAuthState;
  try {
    state = parseOAuthState(url.searchParams.get("state"));
  } catch {
    return NextResponse.redirect(
      `${appUrl}/works?error=${encodeURIComponent("Invalid OAuth state. Please try installing again from the Platform.")}`,
    );
  }

  // Verify HMAC signature when vm0UserId is present
  if (state.vm0UserId) {
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
        `${appUrl}/works?error=${encodeURIComponent("Invalid state signature. Please try installing again from the Platform.")}`,
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
      `${appUrl}/works?error=${encodeURIComponent("Missing default agent. Please set VM0_DEFAULT_AGENT or select an agent before connecting GitHub.")}`,
    );
  }

  // Handle setup_action=request — user requested install on an org they don't admin.
  // GitHub sends no installation_id in this case. Create a pending record.
  if (setupAction === "request") {
    const targetId = url.searchParams.get("target_id");
    const targetType = url.searchParams.get("target_type") ?? "Organization";

    await globalThis.services.db.insert(githubInstallations).values({
      installationId: null,
      encryptedAccessToken: null,
      status: "pending",
      targetId,
      targetType,
      defaultComposeId: composeId,
    });

    return NextResponse.redirect(`${appUrl}/works?pending=true`);
  }

  // For install action, installation_id is required
  if (!installationId) {
    return NextResponse.redirect(
      `${appUrl}/works?error=${encodeURIComponent("Missing installation ID from GitHub")}`,
    );
  }

  const db = globalThis.services.db;

  // Check if installation already exists
  const [existing] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);

  if (existing) {
    // Installation exists — create user link if vm0UserId present and not already linked
    if (state.vm0UserId) {
      await linkVm0User(db, existing.id, state.vm0UserId);
    }
    return NextResponse.redirect(`${appUrl}/works`);
  }

  // Get installation info from GitHub API (target type, ID, name)
  const installInfo = await getInstallationInfo(
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    installationId,
  );

  // Get installation access token from GitHub
  const { token } = await getInstallationAccessToken(
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    installationId,
  );

  // Encrypt token before storage
  const encryptedAccessToken = encryptSecretValue(
    token,
    SECRETS_ENCRYPTION_KEY,
  );

  // For User-type installations, the account IS the admin
  const adminGithubUserId =
    installInfo.targetType === "User" ? installInfo.targetId : null;

  // Create installation record (org-level, no userId)
  // Check for a pending record for this target first
  const [pendingRecord] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.targetId, installInfo.targetId),
        eq(githubInstallations.status, "pending"),
      ),
    )
    .limit(1);

  let installRecordId: string;

  if (pendingRecord) {
    // Activate pending record
    await db
      .update(githubInstallations)
      .set({
        status: "active",
        installationId,
        encryptedAccessToken,
        targetType: installInfo.targetType,
        targetName: installInfo.targetName,
        adminGithubUserId,
        updatedAt: new Date(),
      })
      .where(eq(githubInstallations.id, pendingRecord.id));
    installRecordId = pendingRecord.id;
  } else {
    // Create new installation record
    const [newInstall] = await db
      .insert(githubInstallations)
      .values({
        installationId,
        encryptedAccessToken,
        status: "active",
        targetType: installInfo.targetType,
        targetId: installInfo.targetId,
        targetName: installInfo.targetName,
        adminGithubUserId,
        defaultComposeId: composeId,
      })
      .returning({ id: githubInstallations.id });
    installRecordId = newInstall!.id;
  }

  // Create user link if vm0UserId is present
  if (state.vm0UserId) {
    await linkVm0User(db, installRecordId, state.vm0UserId, adminGithubUserId);
  }

  return NextResponse.redirect(`${appUrl}/works`);
}

/**
 * Link a VM0 user to a GitHub installation via github_user_links.
 *
 * For User-type installations, the GitHub user ID is known from the
 * installation target. For Org-type installations, falls back to looking
 * up the user's GitHub OAuth connector.
 */
export async function linkVm0User(
  db: typeof globalThis.services.db,
  installRecordId: string,
  vm0UserId: string,
  knownGithubUserId?: string | null,
): Promise<string | null> {
  let githubUserId = knownGithubUserId ?? null;

  // If not provided (org install), look up via GitHub OAuth connector
  if (!githubUserId) {
    const [connector] = await db
      .select({ externalId: connectors.externalId })
      .from(connectors)
      .where(
        and(eq(connectors.userId, vm0UserId), eq(connectors.type, "github")),
      )
      .limit(1);

    githubUserId = connector?.externalId ?? null;
  }

  if (!githubUserId) {
    return null;
  }

  // Create user link (ignore conflict if already linked)
  await db
    .insert(githubUserLinks)
    .values({
      githubUserId,
      installationId: installRecordId,
      vm0UserId,
    })
    .onConflictDoNothing();

  return githubUserId;
}
