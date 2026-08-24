import { optionalEnv } from "../../lib/env";
import {
  githubAppBotUsername,
  resolveGithubAppIdentity,
} from "../../lib/github-official-app";

function configuredAppIdentity(args: {
  readonly appId: string | null;
  readonly appSlug: string | null;
}) {
  const { appId, appSlug } = resolveGithubAppIdentity({
    configuredAppId: optionalEnv("GITHUB_APP_ID"),
    configuredAppSlug: optionalEnv("GITHUB_APP_SLUG"),
    installationAppId: args.appId,
    installationAppSlug: args.appSlug,
  });
  if (!appSlug) {
    return { appId, botUsername: undefined };
  }
  return { appId, botUsername: githubAppBotUsername(appSlug) };
}

function buildIntegrationPrompt(args: {
  readonly appId: string | null;
  readonly appSlug: string | null;
}): string {
  const headerParts = [
    "# Current Integration",
    "You are currently running inside: GitHub",
    "GitHub comments run agents when issues or pull requests address the installed GitHub App.",
  ];
  const { appId, botUsername } = configuredAppIdentity(args);
  if (appId) {
    headerParts.push(`GitHub App ID: ${appId}`);
  }
  if (botUsername) {
    headerParts.push(`Bot username: ${botUsername}`);
  }
  return headerParts.join("\n");
}

export function buildGitHubPrompt(args: {
  readonly issueContext: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly subjectKind: "issue" | "pull_request";
  readonly appId: string | null;
  readonly appSlug: string | null;
}): string {
  return [buildIntegrationPrompt(args), args.issueContext]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}
