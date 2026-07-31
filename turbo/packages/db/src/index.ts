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
import * as systemStoragePresignedUrlCacheSchema from "./schema/system-storage-presigned-url-cache";
import * as blobSchema from "./schema/blob";

import * as sandboxTelemetrySchema from "./schema/sandbox-telemetry";
import * as runnerSchema from "./schema/runner-job-queue";
import * as runnerStateSchema from "./schema/runner-state";
import * as agentRunQueueSchema from "./schema/agent-run-queue";
import * as chatAutomationContextSchema from "./schema/chat-automation-context";
import * as chatEventInputParamsSchema from "./schema/chat-event-input-params";
import * as chatFeishuContextSchema from "./schema/chat-feishu-context";
import * as chatGoalContextSchema from "./schema/chat-goal-context";
import * as chatSlackContextSchema from "./schema/chat-slack-context";
import * as secretSchema from "./schema/secret";
import * as modelProviderSchema from "./schema/model-provider";
import * as modelProviderGatewaySchema from "./schema/model-provider-gateway";
import * as orgModelPolicySchema from "./schema/org-model-policy";
import * as modelStatSchema from "./schema/model-stat";
import * as modelUsageObservationSchema from "./schema/model-usage-observation";
import * as variableSchema from "./schema/variable";
import * as composeJobSchema from "./schema/compose-job";
import * as connectorSchema from "./schema/connector";
import * as connectorExternalCodeSessionSchema from "./schema/connector-external-code-session";
import * as modelProviderAuthSessionSchema from "./schema/model-provider-auth-session";
import * as connectorOauthDeviceAuthorizationSessionSchema from "./schema/connector-oauth-device-authorization-session";
import * as connectorOauthStateSchema from "./schema/connector-oauth-state";
import * as usageEventSchema from "./schema/usage-event";
import * as usageEventHourlyRollupSchema from "./schema/usage-event-hourly-rollup";
import * as runBuiltInAdmissionSchema from "./schema/run-built-in-admission";
import * as usageDailySchema from "./schema/usage-daily";
import * as githubInstallationSchema from "./schema/github-installation";
import * as githubUserLinkSchema from "./schema/github-user-link";
import * as githubChatThreadRouteSchema from "./schema/github-chat-thread-route";
import * as telegramInstallationSchema from "./schema/telegram-installation";
import * as telegramOfficialUserLinkSchema from "./schema/telegram-official-user-link";
import * as telegramUserLinkSchema from "./schema/telegram-user-link";
import * as telegramUserAgentPreferenceSchema from "./schema/telegram-user-agent-preference";
import * as telegramChatThreadRouteSchema from "./schema/telegram-chat-thread-route";
import * as telegramMessageSchema from "./schema/telegram-message";
import * as agentphoneUserLinkSchema from "./schema/agentphone-user-link";
import * as agentphoneUserAgentPreferenceSchema from "./schema/agentphone-user-agent-preference";
import * as agentphoneChatThreadRouteSchema from "./schema/agentphone-chat-thread-route";
import * as agentphoneMessageSchema from "./schema/agentphone-message";
import * as agentphoneVerificationSendCooldownSchema from "./schema/agentphone-verification-send-cooldown";
import * as slackOrgInstallationSchema from "./schema/slack-org-installation";
import * as slackOrgConnectionSchema from "./schema/slack-org-connection";
import * as slackChatThreadRouteSchema from "./schema/slack-chat-thread-route";
import * as slackChatIngressSchema from "./schema/slack-chat-ingress";
import * as slackUserAgentPreferenceSchema from "./schema/slack-user-agent-preference";
import * as teamsOrgInstallationSchema from "./schema/teams-org-installation";
import * as teamsOrgConnectionSchema from "./schema/teams-org-connection";
import * as teamsChatThreadRouteSchema from "./schema/teams-chat-thread-route";
import * as teamsUserAgentPreferenceSchema from "./schema/teams-user-agent-preference";
import * as feishuOrgInstallationSchema from "./schema/feishu-org-installation";
import * as feishuOrgConnectionSchema from "./schema/feishu-org-connection";
import * as feishuOrgEventSchema from "./schema/feishu-org-event";
import * as feishuChatThreadRouteSchema from "./schema/feishu-chat-thread-route";
import * as feishuChatIngressSchema from "./schema/feishu-chat-ingress";
import * as feishuUserAgentPreferenceSchema from "./schema/feishu-user-agent-preference";
import * as e2eTeamsMockCallLogSchema from "./schema/e2e-teams-mock-call-log";
import * as e2eTelegramMockCallLogSchema from "./schema/e2e-telegram-mock-call-log";
import * as orgSchema from "./schema/org-metadata";
import * as orgPlanEntitlementSchema from "./schema/org-plan-entitlement";
import * as orgConcurrencyEntitlementSchema from "./schema/org-concurrency-entitlement";
import * as orgConcurrencySubscriptionSchema from "./schema/org-concurrency-subscription";
import * as orgUsageAllowanceSchema from "./schema/org-usage-allowance";
import * as orgCacheSchema from "./schema/org-cache";
import * as orgMembersSchema from "./schema/org-members-metadata";
import * as orgMembersCacheSchema from "./schema/org-members-cache";
import * as userCacheSchema from "./schema/user-cache";
import * as exportJobSchema from "./schema/export-job";
import * as emailSuppressionSchema from "./schema/email-suppression";
import * as skillSchema from "./schema/skill";
import * as usagePricingSchema from "./schema/usage-pricing";
import * as zeroAgentSchema from "./schema/zero-agent";
import * as zeroAgentDraftSchema from "./schema/zero-agent-draft";
import * as userPermissionGrantSchema from "./schema/user-permission-grant";
import * as zeroRunSchema from "./schema/zero-run";
import * as threadGoalSchema from "./schema/thread-goal";
import * as storageVersionLineageSchema from "./schema/storage-version-lineage";
import * as runUploadedFileSchema from "./schema/run-uploaded-file";
import * as vm0ApiKeySchema from "./schema/vm0-api-key";
import * as zeroWorkflowSchema from "./schema/zero-workflow";
import * as morningBriefSchema from "./schema/morning-brief";
import * as computerUseHostSchema from "./schema/computer-use-host";
import * as insightsDailySchema from "./schema/insights-daily";
import * as userFeatureSwitchesSchema from "./schema/user-feature-switches";
import * as userBehaviorCountSchema from "./schema/user-behavior-count";
import * as chatEventSchema from "./schema/chat-event";
import * as chatThreadEventSchema from "./schema/chat-thread-event";
import * as chatThreadSnapshotSchema from "./schema/chat-thread-snapshot";
import * as runOutputMaterializationSchema from "./schema/run-output-materialization";
import * as agentRunCustomConnectorAuthRefSchema from "./schema/agent-run-custom-connector-auth-ref";
import * as orgCustomConnectorSchema from "./schema/org-custom-connector";
import * as orgCustomConnectorOauthConfigSchema from "./schema/org-custom-connector-oauth-config";
import * as orgCustomConnectorSecretSchema from "./schema/org-custom-connector-secret";
import * as orgCustomConnectorValueSchema from "./schema/org-custom-connector-value";
import * as hostedSiteSchema from "./schema/hosted-site";
import * as artifactSchema from "./schema/artifact";
import * as imageArtifactEditSnapshotSchema from "./schema/image-artifact-edit-snapshot";
import * as userArtifactFavoriteSchema from "./schema/user-artifact-favorite";
import * as builtInGenerationJobSchema from "./schema/built-in-generation-job";
import * as bankingSchema from "./schema/banking";
import * as gmailEventSchema from "./schema/gmail-event";
import * as notionEventSchema from "./schema/notion-event";
import * as strapiIntegrationSchema from "./schema/strapi-integration";
import * as googleCalendarEventSchema from "./schema/google-calendar-event";
import * as googleWorkspaceEventSchema from "./schema/google-workspace-event";
import * as connectorCatalogSchema from "./schema/connector-catalog";
import * as mailDraftSchema from "./schema/mail-draft";
import * as browserSessionSchema from "./schema/browser-session";

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
  ...systemStoragePresignedUrlCacheSchema,
  ...blobSchema,

  ...sandboxTelemetrySchema,
  ...runnerSchema,
  ...runnerStateSchema,
  ...agentRunQueueSchema,
  ...chatAutomationContextSchema,
  ...chatEventInputParamsSchema,
  ...chatFeishuContextSchema,
  ...chatGoalContextSchema,
  ...chatSlackContextSchema,
  ...secretSchema,
  ...modelProviderSchema,
  ...modelProviderGatewaySchema,
  ...orgModelPolicySchema,
  ...modelStatSchema,
  ...modelUsageObservationSchema,
  ...slackOrgInstallationSchema,
  ...slackOrgConnectionSchema,
  ...slackChatThreadRouteSchema,
  ...slackChatIngressSchema,
  ...slackUserAgentPreferenceSchema,
  ...teamsOrgInstallationSchema,
  ...teamsOrgConnectionSchema,
  ...teamsChatThreadRouteSchema,
  ...teamsUserAgentPreferenceSchema,
  ...feishuOrgInstallationSchema,
  ...feishuOrgConnectionSchema,
  ...feishuOrgEventSchema,
  ...feishuChatThreadRouteSchema,
  ...feishuChatIngressSchema,
  ...feishuUserAgentPreferenceSchema,
  ...e2eTeamsMockCallLogSchema,
  ...e2eTelegramMockCallLogSchema,
  ...variableSchema,
  ...composeJobSchema,
  ...connectorSchema,
  ...connectorExternalCodeSessionSchema,
  ...modelProviderAuthSessionSchema,
  ...connectorOauthDeviceAuthorizationSessionSchema,
  ...connectorOauthStateSchema,
  ...usageEventSchema,
  ...usageEventHourlyRollupSchema,
  ...runBuiltInAdmissionSchema,
  ...usageDailySchema,
  ...githubInstallationSchema,
  ...githubUserLinkSchema,
  ...githubChatThreadRouteSchema,
  ...telegramInstallationSchema,
  ...telegramOfficialUserLinkSchema,
  ...telegramUserLinkSchema,
  ...telegramUserAgentPreferenceSchema,
  ...telegramChatThreadRouteSchema,
  ...telegramMessageSchema,
  ...agentphoneUserLinkSchema,
  ...agentphoneUserAgentPreferenceSchema,
  ...agentphoneChatThreadRouteSchema,
  ...agentphoneMessageSchema,
  ...agentphoneVerificationSendCooldownSchema,
  ...orgSchema,
  ...orgPlanEntitlementSchema,
  ...orgConcurrencyEntitlementSchema,
  ...orgConcurrencySubscriptionSchema,
  ...orgUsageAllowanceSchema,
  ...orgCacheSchema,
  ...orgMembersSchema,
  ...orgMembersCacheSchema,
  ...userCacheSchema,
  ...exportJobSchema,
  ...emailSuppressionSchema,
  ...skillSchema,
  ...usagePricingSchema,
  ...zeroAgentSchema,
  ...zeroAgentDraftSchema,
  ...userPermissionGrantSchema,
  ...zeroRunSchema,
  ...threadGoalSchema,
  ...storageVersionLineageSchema,
  ...runUploadedFileSchema,
  ...vm0ApiKeySchema,
  ...zeroWorkflowSchema,
  ...morningBriefSchema,
  ...computerUseHostSchema,
  ...insightsDailySchema,
  ...userFeatureSwitchesSchema,
  ...userBehaviorCountSchema,
  ...chatEventSchema,
  ...chatThreadEventSchema,
  ...chatThreadSnapshotSchema,
  ...runOutputMaterializationSchema,
  ...agentRunCustomConnectorAuthRefSchema,
  ...orgCustomConnectorSchema,
  ...orgCustomConnectorOauthConfigSchema,
  ...orgCustomConnectorSecretSchema,
  ...orgCustomConnectorValueSchema,
  ...hostedSiteSchema,
  ...artifactSchema,
  ...imageArtifactEditSnapshotSchema,
  ...userArtifactFavoriteSchema,
  ...builtInGenerationJobSchema,
  ...bankingSchema,
  ...gmailEventSchema,
  ...notionEventSchema,
  ...strapiIntegrationSchema,
  ...googleCalendarEventSchema,
  ...googleWorkspaceEventSchema,
  ...connectorCatalogSchema,
  ...mailDraftSchema,
  ...browserSessionSchema,
};

export type DatabaseSchema = typeof schema;
