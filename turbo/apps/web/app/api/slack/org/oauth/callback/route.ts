import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { env } from "../../../../../../src/env";
import {
  exchangeOAuthCode,
  getSlackRedirectBaseUrl,
  createSlackClient,
} from "../../../../../../src/lib/slack";
import { encryptSecretValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { slackOrgInstallations } from "../../../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../../../src/db/schema/slack-org-connection";
import { requireOrgMember } from "../../../../../../src/lib/org/org-member-service";
import { refreshOrgAppHome } from "../../../../../../src/lib/slack-org/handlers/app-home";
import { getPlatformUrl } from "../../../../../../src/lib/url";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("slack-org:oauth-callback");

interface OAuthState {
  orgId: string | null;
  vm0UserId: string | null;
}

function parseOAuthState(state: string | null): OAuthState {
  if (!state) return { orgId: null, vm0UserId: null };
  try {
    const parsed = JSON.parse(state) as {
      orgId?: string;
      vm0UserId?: string;
    };
    return {
      orgId: parsed.orgId ?? null,
      vm0UserId: parsed.vm0UserId ?? null,
    };
  } catch {
    return { orgId: null, vm0UserId: null };
  }
}

/**
 * Org-aware Slack OAuth Callback
 *
 * GET /api/slack/org/oauth/callback
 *
 * Handles the OAuth redirect from Slack after app installation.
 *
 * Platform flow (state has orgId + vm0UserId):
 *   - Verify user is org admin
 *   - Upsert installation with org_id and installed_by_user_id
 *   - Create connection record
 *   - Redirect to platform
 *
 * Slack flow (no orgId in state):
 *   - Upsert installation with org_id = NULL
 *   - Redirect to "workspace installed" page
 *
 * Re-install (installation exists with org_id):
 *   - Preserve org_id and installed_by_user_id
 *   - Update bot token only
 *
 * Note: User-level connect is handled by /api/slack/org/connect (cookie-based).
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
  const platformUrl = getPlatformUrl();

  if (error) {
    return NextResponse.redirect(
      `${platformUrl}/slack/failed?error=${encodeURIComponent(error)}`,
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
      `${platformUrl}/slack/failed?error=${encodeURIComponent("Failed to complete Slack installation. Please try again.")}`,
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
        `${platformUrl}/zero/works?error=${encodeURIComponent("This Slack workspace is already installed by another organization. Please contact the workspace admin to uninstall first.")}`,
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
    // Verify user is org admin
    const member = await requireOrgMember(state.orgId, state.vm0UserId);
    if (member.role !== "admin") {
      return NextResponse.redirect(
        `${platformUrl}/slack/failed?error=${encodeURIComponent("Only org admins can install Slack for an organization.")}`,
      );
    }

    // Create connection (idempotent via unique constraint)
    await db
      .insert(slackOrgConnections)
      .values({
        slackUserId: oauthResult.authedUserId,
        slackWorkspaceId: oauthResult.teamId,
        vm0UserId: state.vm0UserId,
        orgId: state.orgId,
      })
      .onConflictDoNothing();

    // Refresh App Home for the installing user (best-effort)
    const client = createSlackClient(oauthResult.accessToken);
    const [inst] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, oauthResult.teamId))
      .limit(1);
    if (inst) {
      await refreshOrgAppHome(client, inst, oauthResult.authedUserId).catch(
        (err) =>
          log.warn("Failed to refresh App Home after install", { error: err }),
      );
    }

    return NextResponse.redirect(`${platformUrl}/zero/works?installed=1`);
  }

  // Slack flow: redirect to success page
  return NextResponse.redirect(
    `${platformUrl}/slack/installed?workspace=${encodeURIComponent(oauthResult.teamName)}`,
  );
}
