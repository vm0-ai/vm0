import * as userSchema from "./schema/user";
import * as deviceCodesSchema from "./schema/device-codes";
import * as cliTokensSchema from "./schema/cli-tokens";
import * as agentComposeSchema from "./schema/agent-compose";
import * as agentRunSchema from "./schema/agent-run";
import * as agentRunEventSchema from "./schema/agent-run-event";
import * as conversationSchema from "./schema/conversation";
import * as checkpointSchema from "./schema/checkpoint";
import * as agentSessionSchema from "./schema/agent-session";
import * as storageSchema from "./schema/storage";
import * as blobSchema from "./schema/blob";

import * as sandboxTelemetrySchema from "./schema/sandbox-telemetry";
import * as agentRunEventsLocalSchema from "./schema/agent-run-events-local";
import * as scopeSchema from "./schema/scope";
import * as runnerSchema from "./schema/runner-job-queue";
import * as agentScheduleSchema from "./schema/agent-schedule";
import * as secretSchema from "./schema/secret";
import * as modelProviderSchema from "./schema/model-provider";
import * as slackInstallationSchema from "./schema/slack-installation";
import * as slackUserLinkSchema from "./schema/slack-user-link";

import * as slackThreadSessionSchema from "./schema/slack-thread-session";
import * as slackComposeRequestSchema from "./schema/slack-compose-request";
import * as variableSchema from "./schema/variable";
import * as composeJobSchema from "./schema/compose-job";
import * as connectorSchema from "./schema/connector";
import * as usageDailySchema from "./schema/usage-daily";
import * as emailThreadSessionSchema from "./schema/email-thread-session";
import * as emailReplyRequestSchema from "./schema/email-reply-request";
import * as githubInstallationSchema from "./schema/github-installation";
import * as githubUserLinkSchema from "./schema/github-user-link";
import * as githubIssueSessionSchema from "./schema/github-issue-session";
import * as scopeMemberSchema from "./schema/scope-member";
import * as telegramInstallationSchema from "./schema/telegram-installation";
import * as telegramUserLinkSchema from "./schema/telegram-user-link";
import * as telegramThreadSessionSchema from "./schema/telegram-thread-session";
import * as telegramMessageSchema from "./schema/telegram-message";

export const schema = {
  ...userSchema,
  ...deviceCodesSchema,
  ...cliTokensSchema,
  ...agentComposeSchema,
  ...agentRunSchema,
  ...agentRunEventSchema,
  ...conversationSchema,
  ...checkpointSchema,
  ...agentSessionSchema,
  ...storageSchema,
  ...blobSchema,

  ...sandboxTelemetrySchema,
  ...agentRunEventsLocalSchema,
  ...scopeSchema,
  ...runnerSchema,
  ...agentScheduleSchema,
  ...secretSchema,
  ...modelProviderSchema,
  ...slackInstallationSchema,
  ...slackUserLinkSchema,

  ...slackThreadSessionSchema,
  ...slackComposeRequestSchema,
  ...variableSchema,
  ...composeJobSchema,
  ...connectorSchema,
  ...usageDailySchema,
  ...emailThreadSessionSchema,
  ...emailReplyRequestSchema,
  ...githubInstallationSchema,
  ...githubUserLinkSchema,
  ...githubIssueSessionSchema,
  ...scopeMemberSchema,
  ...telegramInstallationSchema,
  ...telegramUserLinkSchema,
  ...telegramThreadSessionSchema,
  ...telegramMessageSchema,
};
