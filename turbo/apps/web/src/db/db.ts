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
import * as imageSchema from "./schema/image";
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
  ...imageSchema,
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
};
