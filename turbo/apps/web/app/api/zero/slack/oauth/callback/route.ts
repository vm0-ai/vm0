import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { env } from "../../../../../../src/env";
import {
  exchangeOAuthCode,
  exchangeOAuthCodeForUser,
} from "../../../../../../src/lib/zero/slack";
import { getApiUrl } from "../../../../../../src/lib/infra/callback";
import { encryptSecretValue } from "../../../../../../src/lib/shared/crypto/secrets-encryption";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { requireOrgMember } from "../../../../../../src/lib/zero/org/org-member-service";
import {
  adminConnect,
  memberConnect,
  notifyConnectSuccess,
} from "../../../../../../src/lib/zero/slack-org/connect-service";
import { getAppUrl } from "../../../../../../src/lib/zero/url";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("slack-org:oauth-callback");

interface OAuthState {
  orgId: string | null;
  vm0UserId: string | null;
  flow: "install" | "connect";
  reinstall: boolean;
  /**
   * Optional prompt captured from the entry URL (e.g. a use-case CTA).
   * When present, the DM greeting asks the user whether they want to run it.
   */
  prompt: string | null;
}

function parseOAuthState(state: string | null): OAuthState {
  if (!state) {
    return {
      orgId: null,
      vm0UserId: null,
      flow: "install",
      reinstall: false,
      prompt: null,
    };
  }
  try {
    const parsed = JSON.parse(state) as {
      orgId?: string;
      vm0UserId?: string;
      flow?: string;
      reinstall?: boolean;
      prompt?: string;
    };
    return {
      orgId: parsed.orgId ?? null,
      vm0UserId: parsed.vm0UserId ?? null,
      flow: parsed.flow === "connect" ? "connect" : "install",
      reinstall: parsed.reinstall === true,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : null,
    };
  } catch {
    return {
      orgId: null,
      vm0UserId: null,
      flow: "install",
      reinstall: false,
      prompt: null,
    };
  }
}

/**
 * Org-aware Slack OAuth Callback
 *
 * GET /api/zero/slack/oauth/callback
 *
 * Handles OAuth redirects from Slack for two flows:
 *
 * 1. Install flow (state.flow = "install", default):
 *    - Upsert installation with bot token
 *    - Platform flow (orgId + vm0UserId): verify admin, create connection
 *    - Slack flow (no orgId): create unbound installation
 *
 * 2. Connect flow (state.flow = "connect"):
 *    - User already has an installed workspace; just needs to link their Slack identity
 *    - Exchange code for authed_user.id
 *    - Look up installation for the org, create connection record
 *    - Redirect to /slack/connect
 */
export async function GET(request: Request) {
  initServices();

  const { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SECRETS_ENCRYPTION_KEY } =
    env();

  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const baseUrl = getApiUrl();
  const appUrl = getAppUrl();

  if (error) {
    return NextResponse.redirect(
      `${appUrl}/slack/failed?error=${encodeURIComponent(error)}`,
    );
  }

  if (!code) {
    return NextResponse.json(
      { error: "Missing authorization code" },
      { status: 400 },
    );
  }

  const state = parseOAuthState(url.searchParams.get("state"));
  const redirectUri = `${baseUrl}/api/zero/slack/oauth/callback`;

  // Connect flow uses a lightweight exchange that may not return bot tokens.
  // We use a separate helper that tolerates missing bot fields.
  if (state.flow === "connect") {
    return handleConnectCallback({
      code,
      redirectUri,
      state,
      appUrl,
      clientId: SLACK_CLIENT_ID,
      clientSecret: SLACK_CLIENT_SECRET,
    });
  }

  return handleInstallCallback({
    code,
    redirectUri,
    state,
    appUrl,
    clientId: SLACK_CLIENT_ID,
    clientSecret: SLACK_CLIENT_SECRET,
    secretsKey: SECRETS_ENCRYPTION_KEY,
  });
}

/**
 * Handle the OAuth callback for the "install" flow.
 *
 * Exchanges the authorization code for a bot token, upserts the workspace
 * installation, and — for platform-initiated installs — verifies admin status
 * and creates a connection record.
 */
async function handleInstallCallback(params: {
  code: string;
  redirectUri: string;
  state: OAuthState;
  appUrl: string;
  clientId: string;
  clientSecret: string;
  secretsKey: string;
}): Promise<NextResponse> {
  const {
    code,
    redirectUri,
    state,
    appUrl,
    clientId,
    clientSecret,
    secretsKey,
  } = params;

  let oauthResult;
  try {
    oauthResult = await exchangeOAuthCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
    );
  } catch (err) {
    log.error("Slack OAuth exchange failed", { error: err });
    return NextResponse.redirect(
      `${appUrl}/slack/failed?error=${encodeURIComponent("Failed to complete Slack installation. Please try again.")}`,
    );
  }

  const encryptedBotToken = encryptSecretValue(
    oauthResult.accessToken,
    secretsKey,
  );

  // Convert comma-separated scope string to JSON array for storage
  const botScopes = oauthResult.scope
    ? JSON.stringify(oauthResult.scope.split(",").filter(Boolean))
    : null;

  const db = globalThis.services.db;

  // Check existing installation
  const existing = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
    .limit(1)
    .then((rows) => {
      return rows[0] ?? null;
    });

  const isReinstall = existing !== null;

  if (existing) {
    // Reject if workspace is bound to a different org
    if (existing.orgId && state.orgId && existing.orgId !== state.orgId) {
      log.warn("Install rejected: workspace already bound to another org", {
        workspaceId: oauthResult.teamId,
        existingOrgId: existing.orgId,
        requestedOrgId: state.orgId,
      });
      return NextResponse.redirect(
        `${appUrl}/settings/slack?error=${encodeURIComponent("This Slack workspace is already installed by another organization. Please contact the workspace admin to uninstall first.")}`,
      );
    }

    // Re-install (same org): update bot token + scopes, preserve org binding
    await db
      .update(slackOrgInstallations)
      .set({
        encryptedBotToken,
        botUserId: oauthResult.botUserId,
        slackWorkspaceName: oauthResult.teamName,
        botScopes,
        updatedAt: new Date(),
      })
      .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId));

    log.debug("Re-installed Slack workspace, bot token updated", {
      workspaceId: oauthResult.teamId,
      orgId: existing.orgId,
    });
  } else {
    // First install
    const isPlatformFlow = state.orgId && state.vm0UserId;

    await db.insert(slackOrgInstallations).values({
      slackWorkspaceId: oauthResult.teamId,
      slackWorkspaceName: oauthResult.teamName,
      orgId: isPlatformFlow ? state.orgId : null,
      encryptedBotToken,
      botUserId: oauthResult.botUserId,
      installedByUserId: isPlatformFlow ? state.vm0UserId : null,
      botScopes,
    });

    log.debug("New Slack workspace installed", {
      workspaceId: oauthResult.teamId,
      orgId: isPlatformFlow ? state.orgId : null,
    });
  }

  // Platform install flow: verify admin and create connection
  if (state.orgId && state.vm0UserId) {
    return handlePlatformInstall(
      oauthResult,
      {
        orgId: state.orgId,
        vm0UserId: state.vm0UserId,
        reinstall: state.reinstall,
        prompt: state.prompt,
      },
      appUrl,
      isReinstall,
    );
  }

  // Slack flow: redirect to the settings/slack page with workspace + slack user
  // context so the user (after sign-in) can claim the installation into their org
  // via the existing connect flow.
  return NextResponse.redirect(
    `${appUrl}/settings/slack?w=${encodeURIComponent(oauthResult.teamId)}&u=${encodeURIComponent(oauthResult.authedUserId)}`,
  );
}

/**
 * Platform-initiated install: verify admin, create connection, notify, redirect.
 */
async function handlePlatformInstall(
  oauthResult: { authedUserId: string; teamId: string; teamName: string },
  platformState: {
    orgId: string;
    vm0UserId: string;
    reinstall: boolean;
    prompt: string | null;
  },
  appUrl: string,
  isReinstall: boolean,
): Promise<NextResponse> {
  const { orgId, vm0UserId } = platformState;
  const db = globalThis.services.db;

  // Verify user is org admin
  const member = await requireOrgMember(orgId, vm0UserId);
  if (member.role !== "admin") {
    return NextResponse.redirect(
      `${appUrl}/slack/failed?error=${encodeURIComponent("Only org admins can install Slack for an organization.")}`,
    );
  }

  // Create connection (idempotent via unique constraint)
  await db
    .insert(slackOrgConnections)
    .values({
      slackUserId: oauthResult.authedUserId,
      slackWorkspaceId: oauthResult.teamId,
      vm0UserId,
    })
    .onConflictDoNothing();

  // Send DM + welcome and refresh App Home (best-effort, fire-and-forget)
  const [inst] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
    .limit(1);
  if (inst) {
    void notifyConnectSuccess({
      installation: inst,
      slackUserId: oauthResult.authedUserId,
      orgId,
      pendingPrompt: platformState.prompt,
    }).catch((err) => {
      return log.warn("Failed to notify connect success after install", {
        error: err,
      });
    });
  }

  // Reinstall flow: redirect back to Works page with "updated" flag.
  // isReinstall means the workspace already existed in DB;
  // platformState.reinstall means the user explicitly triggered a scope-refresh reinstall.
  if (isReinstall && platformState.reinstall) {
    return NextResponse.redirect(`${appUrl}/?tab=works&updated=1`);
  }

  return NextResponse.redirect(
    `${appUrl}/settings/slack?status=connected&workspace=${encodeURIComponent(oauthResult.teamName)}`,
  );
}

/**
 * Handle the OAuth callback for the "connect" flow.
 *
 * The connect flow is used when a workspace is already installed but the
 * current user hasn't linked their Slack identity yet.  We exchange the
 * OAuth code to learn the user's Slack ID, then create a connection record.
 */
async function handleConnectCallback(params: {
  code: string;
  redirectUri: string;
  state: OAuthState;
  appUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<NextResponse> {
  const { code, redirectUri, state, appUrl, clientId, clientSecret } = params;

  if (!state.orgId || !state.vm0UserId) {
    return NextResponse.redirect(
      `${appUrl}/settings/slack?error=${encodeURIComponent("Invalid connect state.")}`,
    );
  }

  let userIdentity;
  try {
    userIdentity = await exchangeOAuthCodeForUser(
      clientId,
      clientSecret,
      code,
      redirectUri,
    );
  } catch (err) {
    log.error("Slack OAuth exchange failed (connect flow)", { error: err });
    return NextResponse.redirect(
      `${appUrl}/settings/slack?error=${encodeURIComponent("Failed to connect Slack account. Please try again.")}`,
    );
  }

  const db = globalThis.services.db;

  // Find the installation for this org
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, state.orgId))
    .limit(1);

  if (!installation) {
    return NextResponse.redirect(
      `${appUrl}/settings/slack?error=${encodeURIComponent("No Slack workspace installed for this organization.")}`,
    );
  }

  // Verify workspace matches (user must have authed with the right workspace)
  if (userIdentity.teamId !== installation.slackWorkspaceId) {
    return NextResponse.redirect(
      `${appUrl}/settings/slack?error=${encodeURIComponent("You authenticated with a different Slack workspace. Please use the workspace connected to your organization.")}`,
    );
  }

  // Create connection using the appropriate service function
  const member = await requireOrgMember(state.orgId, state.vm0UserId);
  if (member.role === "admin") {
    await adminConnect({
      userId: state.vm0UserId,
      orgId: state.orgId,
      workspaceId: installation.slackWorkspaceId,
      slackUserId: userIdentity.authedUserId,
    });
  } else {
    await memberConnect({
      userId: state.vm0UserId,
      orgId: state.orgId,
      workspaceId: installation.slackWorkspaceId,
      slackUserId: userIdentity.authedUserId,
    });
  }

  log.info("User connected via OAuth", {
    vm0UserId: state.vm0UserId,
    orgId: state.orgId,
    slackUserId: userIdentity.authedUserId,
    workspaceId: installation.slackWorkspaceId,
  });

  // Send DM + refresh App Home (best-effort, fire-and-forget)
  void notifyConnectSuccess({
    installation,
    slackUserId: userIdentity.authedUserId,
    orgId: state.orgId,
    pendingPrompt: state.prompt,
  }).catch((err) => {
    return log.warn("Failed to notify connect success", { error: err });
  });

  return NextResponse.redirect(
    `${appUrl}/settings/slack?status=connected&workspace=${encodeURIComponent(installation.slackWorkspaceName ?? "")}`,
  );
}
