import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  createSlackClient,
  exchangeOAuthCode,
  getSlackRedirectBaseUrl,
  refreshAppHome,
  resolveDefaultAgentComposeId,
} from "../../../../../src/lib/slack";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "../../../../../src/lib/crypto/secrets-encryption";
import { slackInstallations } from "../../../../../src/db/schema/slack-installation";
import { slackUserLinks } from "../../../../../src/db/schema/slack-user-link";
import { ensureScopeAndArtifact } from "../../../../../src/lib/slack/handlers/shared";
import { getUserEmail } from "../../../../../src/lib/auth/get-user-email";
import { addPermission } from "../../../../../src/lib/agent/permission-service";
import { getPlatformUrl } from "../../../../../src/lib/url";

interface OAuthState {
  slackUserId: string | null;
  channelId: string | null;
  defaultComposeId: string | null;
  vm0UserId: string | null;
}

function parseOAuthState(state: string | null): OAuthState {
  const result: OAuthState = {
    slackUserId: null,
    channelId: null,
    defaultComposeId: null,
    vm0UserId: null,
  };
  if (!state) {
    return result;
  }
  try {
    const parsed = JSON.parse(state) as {
      u?: string;
      c?: string;
      composeId?: string;
      vm0UserId?: string;
    };
    result.slackUserId = parsed.u ?? null;
    result.channelId = parsed.c ?? null;
    result.defaultComposeId = parsed.composeId ?? null;
    result.vm0UserId = parsed.vm0UserId ?? null;
  } catch {
    // Ignore parse errors
  }
  return result;
}

interface OAuthInstallation {
  oauthResult: Awaited<ReturnType<typeof exchangeOAuthCode>>;
  encryptedBotToken: string;
  defaultComposeId: string;
  adminSlackUserId: string;
}

async function performOAuthExchange(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  secretsEncryptionKey: string,
  stateComposeId: string | null,
  stateSlackUserId: string | null,
): Promise<OAuthInstallation | NextResponse> {
  const oauthResult = await exchangeOAuthCode(
    clientId,
    clientSecret,
    code,
    redirectUri,
  );

  const encryptedBotToken = encryptCredentialValue(
    oauthResult.accessToken,
    secretsEncryptionKey,
  );

  let defaultComposeId = stateComposeId;
  if (!defaultComposeId) {
    defaultComposeId = await resolveDefaultAgentComposeId();
  }

  if (!defaultComposeId) {
    const baseUrl = new URL(redirectUri).origin;
    return NextResponse.redirect(
      `${baseUrl}/slack/failed?error=${encodeURIComponent("Missing default agent. Install must specify a composeId.")}`,
    );
  }

  const adminSlackUserId =
    oauthResult.authedUserId || stateSlackUserId || "unknown";

  return { oauthResult, encryptedBotToken, defaultComposeId, adminSlackUserId };
}

function buildPostInstallRedirect(
  baseUrl: string,
  installation: OAuthInstallation,
  state: OAuthState,
): NextResponse {
  const { oauthResult } = installation;
  const linkUserId = state.slackUserId || oauthResult.authedUserId || null;

  if (linkUserId && state.channelId) {
    const linkParams = new URLSearchParams({
      w: oauthResult.teamId,
      u: linkUserId,
      c: state.channelId,
    });
    return NextResponse.redirect(
      `${baseUrl}/slack/link?${linkParams.toString()}`,
    );
  }

  if (linkUserId) {
    const linkParams = new URLSearchParams({
      w: oauthResult.teamId,
      u: linkUserId,
    });
    return NextResponse.redirect(
      `${baseUrl}/slack/link?${linkParams.toString()}`,
    );
  }

  return NextResponse.redirect(
    `${baseUrl}/slack/success?workspace=${encodeURIComponent(oauthResult.teamName)}&workspace_id=${encodeURIComponent(oauthResult.teamId)}`,
  );
}

/**
 * Slack OAuth Callback Endpoint
 *
 * GET /api/slack/oauth/callback
 *
 * Handles the OAuth callback from Slack after user authorizes the app.
 * Exchanges the authorization code for tokens and stores them in the database.
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

  if (error) {
    return NextResponse.redirect(
      `${baseUrl}/slack/failed?error=${encodeURIComponent(error)}`,
    );
  }

  if (!code) {
    return NextResponse.json(
      { error: "Missing authorization code" },
      { status: 400 },
    );
  }

  const state = parseOAuthState(url.searchParams.get("state"));
  const redirectUri = `${baseUrl}/api/slack/oauth/callback`;

  try {
    const result = await performOAuthExchange(
      SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET,
      code,
      redirectUri,
      SECRETS_ENCRYPTION_KEY,
      state.defaultComposeId,
      state.slackUserId,
    );

    if (result instanceof NextResponse) {
      return result;
    }

    const {
      oauthResult,
      encryptedBotToken,
      defaultComposeId,
      adminSlackUserId,
    } = result;

    // Store or update the installation
    await globalThis.services.db
      .insert(slackInstallations)
      .values({
        slackWorkspaceId: oauthResult.teamId,
        slackWorkspaceName: oauthResult.teamName,
        encryptedBotToken,
        botUserId: oauthResult.botUserId,
        defaultComposeId,
        adminSlackUserId,
      })
      .onConflictDoUpdate({
        target: slackInstallations.slackWorkspaceId,
        set: {
          slackWorkspaceName: oauthResult.teamName,
          encryptedBotToken,
          botUserId: oauthResult.botUserId,
          defaultComposeId,
          adminSlackUserId,
          updatedAt: new Date(),
        },
      });

    // Platform flow: VM0 user is already authenticated, create link directly
    if (state.vm0UserId) {
      const resolvedSlackUserId =
        state.slackUserId || oauthResult.authedUserId || null;
      if (resolvedSlackUserId) {
        await createUserLink(
          state.vm0UserId,
          resolvedSlackUserId,
          oauthResult.teamId,
          defaultComposeId,
          adminSlackUserId,
          encryptedBotToken,
          SECRETS_ENCRYPTION_KEY,
        );
      }
      const platformUrl = getPlatformUrl();
      return NextResponse.redirect(`${platformUrl}/settings?tab=integrations`);
    }

    return buildPostInstallRedirect(baseUrl, result, state);
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Failed to complete installation";
    console.error("Slack OAuth callback error:", err);
    return NextResponse.redirect(
      `${baseUrl}/slack/failed?error=${encodeURIComponent(errorMessage)}`,
    );
  }
}

/**
 * Create a Slack user link for the platform flow (user already authenticated).
 * Mirrors the logic in /slack/link/actions.ts linkSlackAccount().
 */
async function createUserLink(
  vm0UserId: string,
  slackUserId: string,
  workspaceId: string,
  defaultComposeId: string,
  adminSlackUserId: string,
  encryptedBotToken: string,
  secretsEncryptionKey: string,
): Promise<void> {
  const db = globalThis.services.db;

  // Check if already linked
  const [existing] = await db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, slackUserId),
        eq(slackUserLinks.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (existing) return;

  // Ensure scope and artifact exist
  await ensureScopeAndArtifact(vm0UserId);

  // Create the link
  await db.insert(slackUserLinks).values({
    slackUserId,
    slackWorkspaceId: workspaceId,
    vm0UserId,
  });

  // Auto-share workspace agent
  const email = await getUserEmail(vm0UserId);
  if (email && defaultComposeId) {
    await addPermission(
      defaultComposeId,
      "email",
      adminSlackUserId,
      email,
    ).catch(() => {});
  }

  // Refresh App Home
  const [installation] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (installation) {
    const botToken = decryptCredentialValue(
      encryptedBotToken,
      secretsEncryptionKey,
    );
    const client = createSlackClient(botToken);
    await refreshAppHome(client, installation, slackUserId).catch(() => {});
  }
}
