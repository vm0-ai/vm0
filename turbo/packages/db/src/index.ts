import * as userSchema from "./schema/user";
import * as deviceCodesSchema from "./schema/device-codes";
import * as cliTokensSchema from "./schema/cli-tokens";
import * as desktopAuthHandoffCodeSchema from "./schema/desktop-auth-handoff-code";
import * as agentComposeSchema from "./schema/agent-compose";
import * as agentRunSchema from "./schema/agent-run";
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
import * as orgModelPolicySchema from "./schema/org-model-policy";
import * as modelStatSchema from "./schema/model-stat";
import * as modelUsageObservationSchema from "./schema/model-usage-observation";
import * as variableSchema from "./schema/variable";
import * as composeJobSchema from "./schema/compose-job";
import * as connectorSchema from "./schema/connector";
import * as modelProviderAuthSessionSchema from "./schema/model-provider-auth-session";
import * as connectorOauthDeviceAuthorizationSessionSchema from "./schema/connector-oauth-device-authorization-session";
import * as connectorOauthStateSchema from "./schema/connector-oauth-state";
import * as usageEventSchema from "./schema/usage-event";
import * as runBuiltInAdmissionSchema from "./schema/run-built-in-admission";
import * as usageDailySchema from "./schema/usage-daily";
import * as emailThreadSessionSchema from "./schema/email-thread-session";
import * as emailReplyRequestSchema from "./schema/email-reply-request";
import * as githubInstallationSchema from "./schema/github-installation";
import * as githubLabelListenerSchema from "./schema/github-label-listener";
import * as githubUserLinkSchema from "./schema/github-user-link";
import * as githubIssueSessionSchema from "./schema/github-issue-session";
import * as telegramInstallationSchema from "./schema/telegram-installation";
import * as telegramOfficialUserLinkSchema from "./schema/telegram-official-user-link";
import * as telegramUserLinkSchema from "./schema/telegram-user-link";
import * as telegramUserAgentPreferenceSchema from "./schema/telegram-user-agent-preference";
import * as telegramThreadSessionSchema from "./schema/telegram-thread-session";
import * as telegramMessageSchema from "./schema/telegram-message";
import * as agentphoneUserLinkSchema from "./schema/agentphone-user-link";
import * as agentphoneUserAgentPreferenceSchema from "./schema/agentphone-user-agent-preference";
import * as agentphoneThreadSessionSchema from "./schema/agentphone-thread-session";
import * as agentphoneMessageSchema from "./schema/agentphone-message";
import * as agentphoneVerificationSendCooldownSchema from "./schema/agentphone-verification-send-cooldown";
import * as slackOrgInstallationSchema from "./schema/slack-org-installation";
import * as slackOrgConnectionSchema from "./schema/slack-org-connection";
import * as slackOrgThreadSessionSchema from "./schema/slack-org-thread-session";
import * as slackUserAgentPreferenceSchema from "./schema/slack-user-agent-preference";
import * as e2eTelegramMockCallLogSchema from "./schema/e2e-telegram-mock-call-log";
import * as orgSchema from "./schema/org-metadata";
import * as orgCacheSchema from "./schema/org-cache";
import * as orgMembersSchema from "./schema/org-members-metadata";
import * as orgMembersCacheSchema from "./schema/org-members-cache";
import * as userCacheSchema from "./schema/user-cache";
import * as exportJobSchema from "./schema/export-job";
import * as emailSuppressionSchema from "./schema/email-suppression";
import * as skillSchema from "./schema/skill";
import * as usagePricingSchema from "./schema/usage-pricing";
import * as zeroAgentSchema from "./schema/zero-agent";
import * as userPermissionGrantSchema from "./schema/user-permission-grant";
import * as zeroRunSchema from "./schema/zero-run";
import * as storageVersionLineageSchema from "./schema/storage-version-lineage";
import * as runUploadedFileSchema from "./schema/run-uploaded-file";
import * as vm0ApiKeySchema from "./schema/vm0-api-key";
import * as zeroSkillSchema from "./schema/zero-skill";
import * as computerUseHostSchema from "./schema/computer-use-host";
import * as insightsDailySchema from "./schema/insights-daily";
import * as userFeatureSwitchesSchema from "./schema/user-feature-switches";
import * as userBehaviorCountSchema from "./schema/user-behavior-count";
import * as chatMessageSchema from "./schema/chat-message";
import * as orgCustomConnectorSchema from "./schema/org-custom-connector";
import * as orgCustomConnectorSecretSchema from "./schema/org-custom-connector-secret";
import * as hostedSiteSchema from "./schema/hosted-site";
import * as builtInGenerationJobSchema from "./schema/built-in-generation-job";
import * as bankingSchema from "./schema/banking";
import * as memoryChangeSummarySchema from "./schema/memory-change-summary";
import * as memoryChangeItemSchema from "./schema/memory-change-item";

export const schema = {
  ...userSchema,
  ...deviceCodesSchema,
  ...cliTokensSchema,
  ...desktopAuthHandoffCodeSchema,
  ...agentComposeSchema,
  ...agentRunSchema,
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
  ...orgModelPolicySchema,
  ...modelStatSchema,
  ...modelUsageObservationSchema,
  ...slackOrgInstallationSchema,
  ...slackOrgConnectionSchema,
  ...slackOrgThreadSessionSchema,
  ...slackUserAgentPreferenceSchema,
  ...e2eTelegramMockCallLogSchema,
  ...variableSchema,
  ...composeJobSchema,
  ...connectorSchema,
  ...modelProviderAuthSessionSchema,
  ...connectorOauthDeviceAuthorizationSessionSchema,
  ...connectorOauthStateSchema,
  ...usageEventSchema,
  ...runBuiltInAdmissionSchema,
  ...usageDailySchema,
  ...emailThreadSessionSchema,
  ...emailReplyRequestSchema,
  ...githubInstallationSchema,
  ...githubLabelListenerSchema,
  ...githubUserLinkSchema,
  ...githubIssueSessionSchema,
  ...telegramInstallationSchema,
  ...telegramOfficialUserLinkSchema,
  ...telegramUserLinkSchema,
  ...telegramUserAgentPreferenceSchema,
  ...telegramThreadSessionSchema,
  ...telegramMessageSchema,
  ...agentphoneUserLinkSchema,
  ...agentphoneUserAgentPreferenceSchema,
  ...agentphoneThreadSessionSchema,
  ...agentphoneMessageSchema,
  ...agentphoneVerificationSendCooldownSchema,
  ...orgSchema,
  ...orgCacheSchema,
  ...orgMembersSchema,
  ...orgMembersCacheSchema,
  ...userCacheSchema,
  ...exportJobSchema,
  ...emailSuppressionSchema,
  ...skillSchema,
  ...usagePricingSchema,
  ...zeroAgentSchema,
  ...userPermissionGrantSchema,
  ...zeroRunSchema,
  ...storageVersionLineageSchema,
  ...runUploadedFileSchema,
  ...vm0ApiKeySchema,
  ...zeroSkillSchema,
  ...computerUseHostSchema,
  ...insightsDailySchema,
  ...userFeatureSwitchesSchema,
  ...userBehaviorCountSchema,
  ...chatMessageSchema,
  ...orgCustomConnectorSchema,
  ...orgCustomConnectorSecretSchema,
  ...hostedSiteSchema,
  ...builtInGenerationJobSchema,
  ...bankingSchema,
  ...memoryChangeSummarySchema,
  ...memoryChangeItemSchema,
};
