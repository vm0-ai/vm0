import { optionalEnv } from "../../lib/env";

export function githubAppBotUsername(): string | undefined {
  const appSlug = optionalEnv("GITHUB_APP_SLUG")?.trim();
  if (!appSlug) {
    return undefined;
  }
  return `@${appSlug}[bot]`;
}

function buildIntegrationPrompt(): string {
  const headerParts = [
    "# Current Integration",
    "You are currently running inside: GitHub",
    "GitHub comments run agents when issues or pull requests mention Zero.",
  ];
  const botUsername = githubAppBotUsername();
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
}): string {
  return [buildIntegrationPrompt(), args.issueContext]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}
