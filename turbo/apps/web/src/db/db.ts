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
import * as scopeSchema from "./schema/scope";
import * as runnerSchema from "./schema/runner-job-queue";
import * as agentScheduleSchema from "./schema/agent-schedule";
import * as credentialSchema from "./schema/credential";
import * as modelProviderSchema from "./schema/model-provider";
import * as slackInstallationSchema from "./schema/slack-installation";
import * as slackUserLinkSchema from "./schema/slack-user-link";
import * as slackBindingSchema from "./schema/slack-binding";
import * as slackThreadSessionSchema from "./schema/slack-thread-session";

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
  ...scopeSchema,
  ...runnerSchema,
  ...agentScheduleSchema,
  ...credentialSchema,
  ...modelProviderSchema,
  ...slackInstallationSchema,
  ...slackUserLinkSchema,
  ...slackBindingSchema,
  ...slackThreadSessionSchema,
};
