import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { env } from "../../../../../../src/env";
import {
  exchangeOAuthCode,
  exchangeOAuthCodeForUser,
  getSlackRedirectBaseUrl,
} from "../../../../../../src/lib/slack";
import { encryptSecretValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { slackOrgInstallations } from "../../../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../../../src/db/schema/slack-org-connection";
import { requireOrgMember } from "../../../../../../src/lib/org/org-member-service";
import {
  adminConnect,
  memberConnect,
  notifyConnectSuccess,
} from "../../../../../../src/lib/slack-org/connect-service";
import { getAppUrl } from "../../../../../../src/lib/url";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("slack-org:oauth-callback");

interface OAuthState {
  orgId: string | null;
  vm0UserId: string | null;
  flow: "install" | "connect";
}

function parseOAuthState(state: string | null): OAuthState {
  if (!state) {
    return { orgId: null, vm0UserId: null, flow: "install" };
  }
  try {
    const parsed = JSON.parse(state) as {
      orgId?: string;
      vm0UserId?: string;
      flow?: string;
    };
    return {
      orgId: parsed.orgId ?? null,
      vm0UserId: parsed.vm0UserId ?? null,
      flow: parsed.flow === "connect" ? "connect" : "install",
    };
  } catch {
    return { orgId: null, vm0UserId: null, flow: "install" };
  }
}

/**
 * Org-aware Slack OAuth Callback
 *
 * GET /api/slack/org/oauth/callback
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
  const baseUrl = getSlackRedirectBaseUrl(request.url);
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
  const redirectUri = `${baseUrl}/api/slack/org/oauth/callback`;

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

  let oauthResult;
  try {
    oauthResult = await exchangeOAuthCode(
      SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET,
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
    SECRETS_ENCRYPTION_KEY,
  );

  const db = globalThis.services.db;

  // Check existing installation
  const existing = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    // Reject if workspace is bound to a different org
    if (existing.orgId && state.orgId && existing.orgId !== state.orgId) {
      log.warn("Install rejected: workspace already bound to another org", {
        workspaceId: oauthResult.teamId,
        existingOrgId: existing.orgId,
        requestedOrgId: state.orgId,
      });
      return NextResponse.redirect(
        `${appUrl}/slack/connect?error=${encodeURIComponent("This Slack workspace is already installed by another organization. Please contact the workspace admin to uninstall first.")}`,
      );
    }

    // Re-install (same org): update bot token, preserve org binding
    await db
      .update(slackOrgInstallations)
      .set({
        encryptedBotToken,
        botUserId: oauthResult.botUserId,
        slackWorkspaceName: oauthResult.teamName,
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
    });

    log.debug("New Slack workspace installed", {
      workspaceId: oauthResult.teamId,
      orgId: isPlatformFlow ? state.orgId : null,
    });
  }

  // Platform install flow: verify admin and create connection
  if (state.orgId && state.vm0UserId) {
    const orgId = state.orgId;
    const vm0UserId = state.vm0UserId;

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
        orgId,
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
      }).catch((err) =>
        log.warn("Failed to notify connect success after install", {
          error: err,
        }),
      );
    }

    return NextResponse.redirect(
      `${appUrl}/slack/connect?status=connected&workspace=${encodeURIComponent(oauthResult.teamName)}`,
    );
  }

  // Slack flow: redirect to success page
  return NextResponse.redirect(
    `${appUrl}/slack/installed?workspace=${encodeURIComponent(oauthResult.teamName)}`,
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
      `${appUrl}/slack/connect?error=${encodeURIComponent("Invalid connect state.")}`,
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
      `${appUrl}/slack/connect?error=${encodeURIComponent("Failed to connect Slack account. Please try again.")}`,
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
      `${appUrl}/slack/connect?error=${encodeURIComponent("No Slack workspace installed for this organization.")}`,
    );
  }

  // Verify workspace matches (user must have authed with the right workspace)
  if (userIdentity.teamId !== installation.slackWorkspaceId) {
    return NextResponse.redirect(
      `${appUrl}/slack/connect?error=${encodeURIComponent("You authenticated with a different Slack workspace. Please use the workspace connected to your organization.")}`,
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
  }).catch((err) =>
    log.warn("Failed to notify connect success", { error: err }),
  );

  return NextResponse.redirect(
    `${appUrl}/slack/connect?status=connected&workspace=${encodeURIComponent(installation.slackWorkspaceName ?? "")}`,
  );
}
