import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  exchangeOAuthCode,
  getSlackRedirectBaseUrl,
  resolveDefaultAgentComposeId,
} from "../../../../../src/lib/slack";
import { encryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { slackInstallations } from "../../../../../src/db/schema/slack-installation";

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
  const state = url.searchParams.get("state");

  // Parse state to get Slack user info and default agent
  let slackUserId: string | null = null;
  let channelId: string | null = null;
  let defaultComposeId: string | null = null;
  if (state) {
    try {
      const parsed = JSON.parse(state) as {
        u?: string;
        c?: string;
        composeId?: string;
      };
      slackUserId = parsed.u ?? null;
      channelId = parsed.c ?? null;
      defaultComposeId = parsed.composeId ?? null;
    } catch {
      // Ignore parse errors
    }
  }

  // Use configured base URL or fall back to request URL
  const baseUrl = getSlackRedirectBaseUrl(request.url);

  // Handle user cancellation or error
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
  // Build redirect URI (must match the one used in /install)
  const redirectUri = `${baseUrl}/api/slack/oauth/callback`;

  try {
    // Exchange code for tokens
    const oauthResult = await exchangeOAuthCode(
      SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET,
      code,
      redirectUri,
    );

    // Encrypt the bot token
    const encryptedBotToken = encryptCredentialValue(
      oauthResult.accessToken,
      SECRETS_ENCRYPTION_KEY,
    );

    // Fall back to SLACK_DEFAULT_AGENT when no composeId is specified
    if (!defaultComposeId) {
      defaultComposeId = await resolveDefaultAgentComposeId();
    }

    if (!defaultComposeId) {
      return NextResponse.redirect(
        `${baseUrl}/slack/failed?error=${encodeURIComponent("Missing default agent. Install must specify a composeId.")}`,
      );
    }

    // The installing user becomes the workspace admin
    const adminSlackUserId =
      oauthResult.authedUserId || slackUserId || "unknown";

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

    // If we have user info from state, redirect to link page for combined flow
    if (slackUserId) {
      const linkParams = new URLSearchParams({
        w: oauthResult.teamId,
        u: slackUserId,
      });
      if (channelId) {
        linkParams.set("c", channelId);
      }
      return NextResponse.redirect(
        `${baseUrl}/slack/link?${linkParams.toString()}`,
      );
    }

    // Otherwise redirect to success page
    return NextResponse.redirect(
      `${baseUrl}/slack/success?workspace=${encodeURIComponent(oauthResult.teamName)}&workspace_id=${encodeURIComponent(oauthResult.teamId)}`,
    );
  } catch (err) {
    // Handle OAuth or database errors
    const errorMessage =
      err instanceof Error ? err.message : "Failed to complete installation";
    console.error("Slack OAuth callback error:", err);
    return NextResponse.redirect(
      `${baseUrl}/slack/failed?error=${encodeURIComponent(errorMessage)}`,
    );
  }
}
