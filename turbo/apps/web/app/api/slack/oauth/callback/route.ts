import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { exchangeOAuthCode } from "../../../../../src/lib/slack/client";
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

  // Handle user cancellation or error
  if (error) {
    const baseUrl = `${url.protocol}//${url.host}`;
    return NextResponse.redirect(
      `${baseUrl}/slack/success?error=${encodeURIComponent(error)}`,
    );
  }

  if (!code) {
    return NextResponse.json(
      { error: "Missing authorization code" },
      { status: 400 },
    );
  }

  // Build redirect URI (must match the one used in /install)
  const baseUrl = `${url.protocol}//${url.host}`;
  const redirectUri = `${baseUrl}/api/slack/oauth/callback`;

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

  // Store or update the installation
  await globalThis.services.db
    .insert(slackInstallations)
    .values({
      slackWorkspaceId: oauthResult.teamId,
      slackWorkspaceName: oauthResult.teamName,
      encryptedBotToken,
      botUserId: oauthResult.botUserId,
    })
    .onConflictDoUpdate({
      target: slackInstallations.slackWorkspaceId,
      set: {
        slackWorkspaceName: oauthResult.teamName,
        encryptedBotToken,
        botUserId: oauthResult.botUserId,
        updatedAt: new Date(),
      },
    });

  // Redirect to success page with workspace info
  return NextResponse.redirect(
    `${baseUrl}/slack/success?workspace=${encodeURIComponent(oauthResult.teamName)}&workspace_id=${encodeURIComponent(oauthResult.teamId)}`,
  );
}
