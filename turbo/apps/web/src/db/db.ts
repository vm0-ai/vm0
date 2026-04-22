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
import * as runnerSchema from "./schema/runner-job-queue";
import * as runnerStateSchema from "./schema/runner-state";
import * as agentRunQueueSchema from "./schema/agent-run-queue";
import * as zeroAgentScheduleSchema from "./schema/zero-agent-schedule";
import * as secretSchema from "./schema/secret";
import * as modelProviderSchema from "./schema/model-provider";
import * as variableSchema from "./schema/variable";
import * as composeJobSchema from "./schema/compose-job";
import * as connectorSchema from "./schema/connector";
import * as usageEventSchema from "./schema/usage-event";
import * as usageDailySchema from "./schema/usage-daily";
import * as emailThreadSessionSchema from "./schema/email-thread-session";
import * as emailReplyRequestSchema from "./schema/email-reply-request";
import * as githubInstallationSchema from "./schema/github-installation";
import * as githubUserLinkSchema from "./schema/github-user-link";
import * as githubIssueSessionSchema from "./schema/github-issue-session";
import * as telegramInstallationSchema from "./schema/telegram-installation";
import * as telegramUserLinkSchema from "./schema/telegram-user-link";
import * as telegramThreadSessionSchema from "./schema/telegram-thread-session";
import * as telegramMessageSchema from "./schema/telegram-message";
import * as slackOrgInstallationSchema from "./schema/slack-org-installation";
import * as slackOrgConnectionSchema from "./schema/slack-org-connection";
import * as slackOrgThreadSessionSchema from "./schema/slack-org-thread-session";
import * as slackUserAgentPreferenceSchema from "./schema/slack-user-agent-preference";
import * as orgSchema from "./schema/org-metadata";
import * as orgCacheSchema from "./schema/org-cache";
import * as orgMembersSchema from "./schema/org-members-metadata";
import * as orgMembersCacheSchema from "./schema/org-members-cache";
import * as userCacheSchema from "./schema/user-cache";
import * as exportJobSchema from "./schema/export-job";
import * as emailSuppressionSchema from "./schema/email-suppression";
import * as skillSchema from "./schema/skill";
import * as creditUsageSchema from "./schema/credit-usage";
import * as clientCreditUsageSchema from "./schema/client-credit-usage";
import * as creditPricingSchema from "./schema/credit-pricing";
import * as zeroAgentSchema from "./schema/zero-agent";
import * as zeroRunSchema from "./schema/zero-run";
import * as storageVersionLineageSchema from "./schema/storage-version-lineage";
import * as vm0ApiKeySchema from "./schema/vm0-api-key";
import * as zeroSkillSchema from "./schema/zero-skill";
import * as computerUseHostSchema from "./schema/computer-use-host";
import * as insightsDailySchema from "./schema/insights-daily";
import * as phoneUserLinkSchema from "./schema/phone-user-link";
import * as phoneThreadSessionSchema from "./schema/phone-thread-session";
import * as pendingOutboundCallSchema from "./schema/pending-outbound-call";
import * as voiceChatSchema from "./schema/voice-chat";
import * as voiceChatCandidateSchema from "./schema/voice-chat-candidate";
import * as userFeatureSwitchesSchema from "./schema/user-feature-switches";
import * as userBehaviorCountSchema from "./schema/user-behavior-count";
import * as chatMessageSchema from "./schema/chat-message";
import * as orgCustomConnectorSchema from "./schema/org-custom-connector";
import * as orgCustomConnectorSecretSchema from "./schema/org-custom-connector-secret";

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
  ...runnerSchema,
  ...runnerStateSchema,
  ...agentRunQueueSchema,
  ...zeroAgentScheduleSchema,
  ...secretSchema,
  ...modelProviderSchema,
  ...slackOrgInstallationSchema,
  ...slackOrgConnectionSchema,
  ...slackOrgThreadSessionSchema,
  ...slackUserAgentPreferenceSchema,
  ...variableSchema,
  ...composeJobSchema,
  ...connectorSchema,
  ...usageEventSchema,
  ...usageDailySchema,
  ...emailThreadSessionSchema,
  ...emailReplyRequestSchema,
  ...githubInstallationSchema,
  ...githubUserLinkSchema,
  ...githubIssueSessionSchema,
  ...telegramInstallationSchema,
  ...telegramUserLinkSchema,
  ...telegramThreadSessionSchema,
  ...telegramMessageSchema,
  ...orgSchema,
  ...orgCacheSchema,
  ...orgMembersSchema,
  ...orgMembersCacheSchema,
  ...userCacheSchema,
  ...exportJobSchema,
  ...emailSuppressionSchema,
  ...skillSchema,
  ...creditUsageSchema,
  ...clientCreditUsageSchema,
  ...creditPricingSchema,
  ...zeroAgentSchema,
  ...zeroRunSchema,
  ...storageVersionLineageSchema,
  ...vm0ApiKeySchema,
  ...zeroSkillSchema,
  ...computerUseHostSchema,
  ...insightsDailySchema,
  ...phoneUserLinkSchema,
  ...phoneThreadSessionSchema,
  ...pendingOutboundCallSchema,
  ...voiceChatSchema,
  ...voiceChatCandidateSchema,
  ...userFeatureSwitchesSchema,
  ...userBehaviorCountSchema,
  ...chatMessageSchema,
  ...orgCustomConnectorSchema,
  ...orgCustomConnectorSecretSchema,
};
