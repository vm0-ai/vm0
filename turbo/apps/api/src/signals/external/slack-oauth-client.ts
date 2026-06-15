import { WebClient } from "@slack/web-api";

interface SlackInstallOAuthResult {
  readonly accessToken: string;
  readonly botUserId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly authedUserId: string;
  readonly scope: string;
}

interface SlackUserOAuthResult {
  readonly teamId: string;
  readonly authedUserId: string;
}

function buildWebClient(): WebClient {
  return new WebClient();
}

export async function exchangeSlackOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SlackInstallOAuthResult> {
  const client = buildWebClient();
  const result = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (
    !result.ok ||
    !result.access_token ||
    !result.bot_user_id ||
    !result.team
  ) {
    throw new Error(
      `OAuth exchange failed: ${result.error ?? "unknown error"}`,
    );
  }

  return {
    accessToken: result.access_token,
    botUserId: result.bot_user_id,
    teamId: result.team.id ?? "",
    teamName: result.team.name ?? "",
    authedUserId: result.authed_user?.id ?? "",
    scope: typeof result.scope === "string" ? result.scope : "",
  };
}

export async function exchangeSlackOAuthCodeForUser(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SlackUserOAuthResult> {
  const client = buildWebClient();
  const result = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (!result.ok || !result.authed_user?.id || !result.team?.id) {
    throw new Error(
      `OAuth user exchange failed: ${result.error ?? "unknown error"}`,
    );
  }

  return {
    teamId: result.team.id,
    authedUserId: result.authed_user.id,
  };
}
