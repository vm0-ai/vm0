import { type ConnectorType } from "@vm0/core";
import { type OAuthTokenResult, type ProviderHandler } from "./provider-types";
import { figmaHandler } from "./providers/figma-handler";
import { githubHandler } from "./providers/github-handler";
import { gmailHandler } from "./providers/gmail-handler";
import { notionHandler } from "./providers/notion-handler";
import { slackHandler } from "./providers/slack-handler";

export type { OAuthTokenResult };

export const PROVIDER_HANDLERS: Record<
  Exclude<ConnectorType, "computer">,
  ProviderHandler
> = {
  figma: figmaHandler,
  github: githubHandler,
  gmail: gmailHandler,
  notion: notionHandler,
  slack: slackHandler,
};
