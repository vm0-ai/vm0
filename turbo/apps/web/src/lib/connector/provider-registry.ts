import { type ConnectorType } from "@vm0/core";
import { type OAuthTokenResult, type ProviderHandler } from "./provider-types";
import { deelHandler } from "./providers/deel-handler";
import { dropboxHandler } from "./providers/dropbox-handler";
import { figmaHandler } from "./providers/figma-handler";
import { githubHandler } from "./providers/github-handler";
import { gmailHandler } from "./providers/gmail-handler";
import { linearHandler } from "./providers/linear-handler";
import { notionHandler } from "./providers/notion-handler";
import { slackHandler } from "./providers/slack-handler";

export type { OAuthTokenResult };

export const PROVIDER_HANDLERS: Record<
  Exclude<ConnectorType, "computer">,
  ProviderHandler
> = {
  deel: deelHandler,
  figma: figmaHandler,
  github: githubHandler,
  gmail: gmailHandler,
  linear: linearHandler,
  notion: notionHandler,
  slack: slackHandler,
  dropbox: dropboxHandler,
};
