import { healthContract } from "@vm0/api-contracts/contracts/health";

import { agentCheckpointsRoutes } from "./routes/agent-checkpoints-id";
import { agentComposesByIdRoutes } from "./routes/agent-composes-id";
import { automationsRoutes } from "./routes/automations";
import { agentComposesReadRoutes } from "./routes/agent-composes-read";
import { agentComposesRoutes } from "./routes/agent-composes";
import { agentRunsCancelRoutes } from "./routes/agent-runs-cancel";
import { agentRunsCreateRoutes } from "./routes/agent-runs-create";
import { agentRunsReadRoutes } from "./routes/agent-runs-read";
import { agentRunTelemetryRoutes } from "./routes/agent-run-telemetry";
import { agentSessionsRoutes } from "./routes/agent-sessions-id";
import { authMeRoutes } from "./routes/auth-me";
import { audioTranscriptionsV1Routes } from "./routes/audio-transcriptions-v1";
import { cliAuthRoutes } from "./routes/cli-auth";
import { cliAuthTestRoutes } from "./routes/cli-auth-test";
import type { RouteEntry } from "./route-entry";
import { chatThreadsV1Routes } from "./routes/chat-threads-v1";
import { connectorsTypeCallbackRoutes } from "./routes/connectors-type-callback";
import { cronAggregateInsightsRoutes } from "./routes/cron-aggregate-insights";
import { cronAggregateUsageRoutes } from "./routes/cron-aggregate-usage";
import { cronCleanupSandboxesRoutes } from "./routes/cron-cleanup-sandboxes";
import { cronDrainEmailOutboxRoutes } from "./routes/cron-drain-email-outbox";
import { cronExecuteAutomationsRoutes } from "./routes/cron-execute-automations";
import { cronExecuteWorkflowTriggersRoutes } from "./routes/cron-execute-workflow-triggers";
import { cronRenewGmailWatchesRoutes } from "./routes/cron-renew-gmail-watches";
import { cronRenewGoogleCalendarWatchesRoutes } from "./routes/cron-renew-google-calendar-watches";
import { cronRenewGoogleWorkspaceEventSubscriptionsRoutes } from "./routes/cron-renew-google-workspace-event-subscriptions";
import { cronProcessUsageEventsRoutes } from "./routes/cron-process-usage-events";
import { cronReconcileBillingEntitlementsRoutes } from "./routes/cron-reconcile-billing-entitlements";
import { cronComputerUseScreenshotCleanupRoutes } from "./routes/cron-computer-use-screenshot-cleanup";
import { cronSummarizeMemoryRoutes } from "./routes/cron-summarize-memory";
import { cronSyncSkillsRoutes } from "./routes/cron-sync-skills";
import { cronTelegramCleanupRoutes } from "./routes/cron-telegram-cleanup";
import { deviceTokenRoutes } from "./routes/device-token";
import { desktopAuthRoutes } from "./routes/desktop-auth";
import { desktopUpdateRoutes } from "./routes/desktop-updates";
import { emailUnsubscribeRoutes } from "./routes/email-unsubscribe";
import { apiHealth$ } from "./routes/health";
import { healthAuthProbeRoutes } from "./routes/health-auth-probe";
import { githubOauthRoutes } from "./routes/github-oauth";
import { legacyFileRoutes } from "./routes/legacy-file";
import { logsSearchRoutes } from "./routes/logs-search";
import { modelStatsRoutes } from "./routes/model-stats";
import { presentationImagesRoutes } from "./routes/presentation-images";
import { registryResourceDownloadRoutes } from "./routes/registry-resources-download";
import { runnersRoutes } from "./routes/runners";
import { usageRoutes } from "./routes/usage";
import { userExportRoutes } from "./routes/user-export";
import { webhooksAgentCheckpointsRoutes } from "./routes/webhooks-agent-checkpoints";
import { webhooksAgentCompleteRoutes } from "./routes/webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "./routes/webhooks-agent-events";
import { webhooksAgentFirewallAuthRoutes } from "./routes/webhooks-agent-firewall-auth";
import { webhooksAgentHealthUsageTelemetryRoutes } from "./routes/webhooks-agent-health-usage-telemetry";
import { webhooksAgentStorageRoutes } from "./routes/webhooks-agent-storage";
import { webhooksBuiltInGenerationRoutes } from "./routes/webhooks-built-in-generations";
import { webhooksClerkRoutes } from "./routes/webhooks-clerk";
import { webhooksGithubRoutes } from "./routes/webhooks-github";
import { webhooksGmailRoutes } from "./routes/webhooks-gmail";
import { webhooksGoogleCalendarRoutes } from "./routes/webhooks-google-calendar";
import { webhooksGoogleWorkspaceEventsRoutes } from "./routes/webhooks-google-workspace-events";
import { webhooksWorkflowTriggersRoutes } from "./routes/webhooks-workflow-triggers";
import { webhooksStripeRoutes } from "./routes/webhooks-stripe";
import { zeroAgentDraftRoutes } from "./routes/zero-agent-drafts";
import { zeroAgentInstructionsRoutes } from "./routes/zero-agent-instructions";
import { zeroAgentsRoutes } from "./routes/zero-agents";
import { zeroApiKeysRoutes } from "./routes/zero-api-keys";
import { zeroAttributionRoutes } from "./routes/zero-attribution";
import { zeroBillingAutoRechargeRoutes } from "./routes/zero-billing-auto-recharge";
import { zeroBillingCheckoutRoutes } from "./routes/zero-billing-checkout";
import { zeroBillingConcurrencyCheckoutRoutes } from "./routes/zero-billing-concurrency-checkout";
import { zeroBillingConcurrencySubscriptionRoutes } from "./routes/zero-billing-concurrency-subscriptions";
import { zeroBillingCreditCheckoutRoutes } from "./routes/zero-billing-credit-checkout";
import { zeroBillingDowngradeRoutes } from "./routes/zero-billing-downgrade";
import { zeroBillingInvoicesRoutes } from "./routes/zero-billing-invoices";
import { zeroBillingPortalRoutes } from "./routes/zero-billing-portal";
import { zeroBillingRedeemCodeRoutes } from "./routes/zero-billing-redeem-code";
import { zeroBillingRedeemRoutes } from "./routes/zero-billing-redeem";
import { zeroBillingRestoreRoutes } from "./routes/zero-billing-restore";
import { zeroBillingStatusRoutes } from "./routes/zero-billing-status";
import { zeroBankingRoutes } from "./routes/zero-banking";
import { zeroChatThreadRoutes } from "./routes/zero-chat-threads";
import { zeroChatMessagesRoutes } from "./routes/zero-chat-messages";
import { zeroClaudeCodeDeviceAuthRoutes } from "./routes/zero-claude-code-device-auth";
import { zeroComposesRoutes } from "./routes/zero-composes";
import { zeroComputerUseAuthorizationRoutes } from "./routes/zero-computer-use-authorization";
import { zeroComputerUseRoutes } from "./routes/zero-computer-use";
import { zeroCodexDeviceAuthRoutes } from "./routes/zero-codex-device-auth";
import { zeroConnectorCatalogRoutes } from "./routes/zero-connector-catalog";
import { zeroConnectorsExternalCodeRoutes } from "./routes/zero-connectors-external-code";
import { zeroConnectorsOauthDeviceAuthRoutes } from "./routes/zero-connectors-oauth-device-auth";
import { zeroConnectorsRoutes } from "./routes/zero-connectors";
import { zeroCustomConnectorsRoutes } from "./routes/zero-custom-connectors";
import { zeroDefaultAgentRoutes } from "./routes/zero-default-agent";
import { zeroDeveloperSupportRoutes } from "./routes/zero-developer-support";
import { zeroEmailCallbackRoutes } from "./routes/zero-email-callbacks";
import { zeroEmailInboundRoutes } from "./routes/zero-email-inbound";
import { zeroFeatureSwitchesRoutes } from "./routes/zero-feature-switches";
import { zeroGoalsRoutes } from "./routes/zero-goals";
import { zeroHostRoutes } from "./routes/zero-host";
import { zeroMemoryRoutes } from "./routes/zero-memory";
import { zeroMemoryActivityRoutes } from "./routes/zero-memory-activity";
import { zeroMemoryDevRefreshRoutes } from "./routes/zero-memory-dev-refresh";
import { zeroBuiltInGenerationRoutes } from "./routes/zero-built-in-generation";
import { zeroInsightsRoutes } from "./routes/zero-insights";
import { zeroImageIoGenerateRoutes } from "./routes/zero-image-io-generate";
import { zeroLogsRoutes } from "./routes/zero-logs";
import { zeroMapsRoutes } from "./routes/zero-maps";
import { zeroModelPoliciesRoutes } from "./routes/zero-model-policies";
import { zeroModelProvidersRoutes } from "./routes/zero-model-providers";
import { zeroOnboardingCompleteLimitedFreeRoutes } from "./routes/zero-onboarding-complete-limited-free";
import { zeroOnboardingSetupRoutes } from "./routes/zero-onboarding-setup";
import { zeroOnboardingStatusRoutes } from "./routes/zero-onboarding-status";
import { zeroOrgInviteRoutes } from "./routes/zero-org-invite";
import { zeroOrgDeleteRoutes } from "./routes/zero-org-delete";
import { zeroOrgLogoRoutes } from "./routes/zero-org-logo";
import { zeroOrgMembersRoutes } from "./routes/zero-org-members";
import { zeroOrgMembershipRequestsRoutes } from "./routes/zero-org-membership-requests";
import { zeroOrgReadRoutes } from "./routes/zero-org-read";
import { zeroPushSubscriptionsRoutes } from "./routes/zero-push-subscriptions";
import { zeroQueuePositionRoutes } from "./routes/zero-queue-position";
import { zeroRealtimeTokenRoutes } from "./routes/zero-realtime-token";
import { zeroReportErrorRoutes } from "./routes/zero-report-error";
import { zeroRunDetailRoutes } from "./routes/zero-run-detail";
import { zeroRunsRoutes } from "./routes/zero-runs";
import { zeroRunsCancelRoutes } from "./routes/zero-runs-cancel";
import { zeroMeModelProvidersDeleteRoutes } from "./routes/zero-me-model-providers-delete";
import { zeroMeModelProvidersListRoutes } from "./routes/zero-me-model-providers-list";
import { zeroMeModelProvidersUpsertRoutes } from "./routes/zero-me-model-providers-upsert";
import { zeroSecretsRoutes } from "./routes/zero-secrets";
import { zeroWorkflowsRoutes } from "./routes/zero-workflows";
import { zeroWorkflowTriggersRoutes } from "./routes/zero-workflow-triggers";
import { integrationsGithubRoutes } from "./routes/integrations-github";
import { zeroIntegrationsAgentPhoneRoutes } from "./routes/zero-integrations-agentphone";
import { zeroIntegrationsPhoneDownloadFileRoutes } from "./routes/zero-integrations-phone-download-file";
import { zeroIntegrationsPhoneMessageRoutes } from "./routes/zero-integrations-phone-message";
import { zeroIntegrationsPhoneUploadCompleteRoutes } from "./routes/zero-integrations-phone-upload-complete";
import { zeroIntegrationsPhoneUploadInitRoutes } from "./routes/zero-integrations-phone-upload-init";
import { zeroIntegrationsGithubDownloadFileRoutes } from "./routes/zero-integrations-github-download-file";
import { zeroIntegrationsGithubUploadCompleteRoutes } from "./routes/zero-integrations-github-upload-complete";
import { zeroIntegrationsGithubUploadInitRoutes } from "./routes/zero-integrations-github-upload-init";
import { zeroIntegrationsSlackRoutes } from "./routes/zero-integrations-slack";
import { zeroIntegrationsSlackMessageRoutes } from "./routes/zero-integrations-slack-message";
import { zeroIntegrationsSlackUploadCompleteRoutes } from "./routes/zero-integrations-slack-upload-complete";
import { zeroIntegrationsSlackUploadInitRoutes } from "./routes/zero-integrations-slack-upload-init";
import { zeroIntegrationsTelegramRoutes } from "./routes/zero-integrations-telegram";
import { zeroIntegrationsTelegramMessageRoutes } from "./routes/zero-integrations-telegram-message";
import { zeroIntegrationsTelegramUploadCompleteRoutes } from "./routes/zero-integrations-telegram-upload-complete";
import { zeroIntegrationsTelegramUploadInitRoutes } from "./routes/zero-integrations-telegram-upload-init";
import { zeroSlackChannelsRoutes } from "./routes/zero-slack-channels";
import { zeroSlackBrowserConnectRoutes } from "./routes/zero-slack-browser-connect";
import { zeroSlackCommandsRoutes } from "./routes/zero-slack-commands";
import { zeroSlackConnectRoutes } from "./routes/zero-slack-connect";
import { zeroSlackEventsRoutes } from "./routes/zero-slack-events";
import { zeroSlackInteractiveRoutes } from "./routes/zero-slack-interactive";
import { zeroSlackOauthRoutes } from "./routes/zero-slack-oauth";
import { zeroTeamsBrowserConnectRoutes } from "./routes/zero-teams-browser-connect";
import { zeroTeamsBotRoutes } from "./routes/zero-teams-bot";
import { zeroTeamsConnectRoutes } from "./routes/zero-teams-connect";
import { zeroTeamRoutes } from "./routes/zero-team";
import { zeroUploadsCompleteRoutes } from "./routes/zero-uploads-complete";
import { zeroUploadsHtmlDomEditSnapshotRoutes } from "./routes/zero-uploads-html-dom-edit-snapshot";
import { zeroUploadsPrepareRoutes } from "./routes/zero-uploads-prepare";
import { zeroUsageInsightRoutes } from "./routes/zero-usage-insight";
import { zeroUsageMembersRoutes } from "./routes/zero-usage-members";
import { zeroUsageRecordRoutes } from "./routes/zero-usage-record";
import { zeroUsageRunsRoutes } from "./routes/zero-usage-runs";
import { zeroUserPreferencesRoutes } from "./routes/zero-user-preferences";
import { zeroUserPermissionGrantsRoutes } from "./routes/zero-user-permission-grants";
import { zeroUserModelPreferenceRoutes } from "./routes/zero-user-model-preference";
import { zeroVoiceIoQuotaRoutes } from "./routes/zero-voice-io-quota";
import { zeroVoiceIoSpeechRoutes } from "./routes/zero-voice-io-speech";
import { zeroVoiceIoSttRoutes } from "./routes/zero-voice-io-stt";
import { zeroVideoIoGenerateRoutes } from "./routes/zero-video-io-generate";
import { zeroWebDownloadRoutes } from "./routes/zero-web-download";
import { storagesCommitRoutes } from "./routes/storages-commit";
import { storagesDownloadRoutes } from "./routes/storages-download";
import { storagesListRoutes } from "./routes/storages-list";
import { storagesPrepareRoutes } from "./routes/storages-prepare";
import { testOAuthProviderAuthorizeRoutes } from "./routes/test-oauth-provider-authorize";
import { testOAuthProviderDeviceAuthRoutes } from "./routes/test-oauth-provider-device-auth";
import { testOAuthProviderEchoRoutes } from "./routes/test-oauth-provider-echo";
import { testOAuthProviderTokenRoutes } from "./routes/test-oauth-provider-token";
import { testOAuthProviderUserinfoRoutes } from "./routes/test-oauth-provider-userinfo";
import { testSlackDispatchProbeRoutes } from "./routes/test-slack-dispatch-probe";
import { testSlackMockRoutes } from "./routes/test-slack-mock";
import { testSlackStateRoutes } from "./routes/test-slack-state";
import { testEmailStateRoutes } from "./routes/test-email-state";
import { testBillingRedeemStateRoutes } from "./routes/test-billing-redeem-state";
import { testBillingStatusStateRoutes } from "./routes/test-billing-status-state";
import { testTelegramDispatchProbeRoutes } from "./routes/test-telegram-dispatch-probe";
import { testTelegramMockRoutes } from "./routes/test-telegram-mock";
import { testTelegramStateRoutes } from "./routes/test-telegram-state";
import { testGenerationStateRoutes } from "./routes/test-generation-state";
import { testOnboardingStatusStateRoutes } from "./routes/test-onboarding-status-state";
import { testMemoryStateRoutes } from "./routes/test-memory-state";
import { testUsageInsightStateRoutes } from "./routes/test-usage-insight-state";
import { testUsageStateRoutes } from "./routes/test-usage-state";
import { testUserExportStateRoutes } from "./routes/test-user-export-state";
import { testWorkflowTriggerStateRoutes } from "./routes/test-workflow-trigger-state";
import { testChatMessagesStateRoutes } from "./routes/test-chat-messages-state";
import { testWebhooksStateRoutes } from "./routes/test-webhooks-state";

export const ROUTES: readonly RouteEntry[] = [
  {
    route: healthContract.check,
    handler: apiHealth$,
  },
  ...authMeRoutes,
  // The unified Automation resource: one automation, N schedule triggers.
  ...automationsRoutes,
  ...cliAuthRoutes,
  ...cliAuthTestRoutes,
  ...desktopAuthRoutes,
  ...desktopUpdateRoutes,
  ...healthAuthProbeRoutes,
  ...githubOauthRoutes,
  ...legacyFileRoutes,
  ...logsSearchRoutes,
  ...usageRoutes,
  ...userExportRoutes,
  ...webhooksClerkRoutes,
  ...webhooksBuiltInGenerationRoutes,
  ...webhooksGithubRoutes,
  ...webhooksGmailRoutes,
  ...webhooksGoogleCalendarRoutes,
  ...webhooksGoogleWorkspaceEventsRoutes,
  ...webhooksWorkflowTriggersRoutes,
  ...webhooksStripeRoutes,
  ...webhooksAgentHealthUsageTelemetryRoutes,
  ...webhooksAgentCheckpointsRoutes,
  ...webhooksAgentCompleteRoutes,
  ...webhooksAgentEventsRoutes,
  ...webhooksAgentFirewallAuthRoutes,
  ...webhooksAgentStorageRoutes,
  ...agentCheckpointsRoutes,
  ...agentComposesReadRoutes,
  ...agentComposesByIdRoutes,
  ...agentComposesRoutes,
  ...agentRunsCreateRoutes,
  ...agentRunsCancelRoutes,
  ...agentRunsReadRoutes,
  ...agentRunTelemetryRoutes,
  ...agentSessionsRoutes,
  ...connectorsTypeCallbackRoutes,
  ...cronAggregateInsightsRoutes,
  ...cronAggregateUsageRoutes,
  ...cronCleanupSandboxesRoutes,
  ...cronDrainEmailOutboxRoutes,
  ...cronExecuteAutomationsRoutes,
  ...cronExecuteWorkflowTriggersRoutes,
  ...cronRenewGmailWatchesRoutes,
  ...cronRenewGoogleCalendarWatchesRoutes,
  ...cronRenewGoogleWorkspaceEventSubscriptionsRoutes,
  ...cronProcessUsageEventsRoutes,
  ...cronReconcileBillingEntitlementsRoutes,
  ...cronComputerUseScreenshotCleanupRoutes,
  ...cronSummarizeMemoryRoutes,
  ...cronSyncSkillsRoutes,
  ...cronTelegramCleanupRoutes,
  ...deviceTokenRoutes,
  ...emailUnsubscribeRoutes,
  ...zeroAgentDraftRoutes,
  ...zeroAgentInstructionsRoutes,
  ...zeroAgentsRoutes,
  ...zeroApiKeysRoutes,
  ...zeroAttributionRoutes,
  ...zeroBillingAutoRechargeRoutes,
  ...zeroBillingCheckoutRoutes,
  ...zeroBillingConcurrencyCheckoutRoutes,
  ...zeroBillingConcurrencySubscriptionRoutes,
  ...zeroBillingCreditCheckoutRoutes,
  ...zeroBillingDowngradeRoutes,
  ...zeroBillingInvoicesRoutes,
  ...zeroBillingPortalRoutes,
  ...zeroBillingRedeemCodeRoutes,
  ...zeroBillingRedeemRoutes,
  ...zeroBillingRestoreRoutes,
  ...zeroBillingStatusRoutes,
  ...zeroBankingRoutes,
  ...zeroChatThreadRoutes,
  ...zeroChatMessagesRoutes,
  ...zeroClaudeCodeDeviceAuthRoutes,
  ...zeroComposesRoutes,
  ...zeroComputerUseAuthorizationRoutes,
  ...zeroComputerUseRoutes,
  ...zeroCodexDeviceAuthRoutes,
  ...zeroConnectorCatalogRoutes,
  ...zeroConnectorsExternalCodeRoutes,
  ...zeroConnectorsOauthDeviceAuthRoutes,
  ...zeroConnectorsRoutes,
  ...zeroCustomConnectorsRoutes,
  ...zeroDefaultAgentRoutes,
  ...zeroDeveloperSupportRoutes,
  ...zeroEmailCallbackRoutes,
  ...zeroEmailInboundRoutes,
  ...zeroFeatureSwitchesRoutes,
  ...zeroGoalsRoutes,
  ...zeroHostRoutes,
  ...zeroMemoryRoutes,
  ...zeroMemoryActivityRoutes,
  ...zeroMemoryDevRefreshRoutes,
  ...zeroBuiltInGenerationRoutes,
  ...zeroInsightsRoutes,
  ...zeroImageIoGenerateRoutes,
  ...zeroVideoIoGenerateRoutes,
  ...zeroLogsRoutes,
  ...zeroMapsRoutes,
  ...zeroModelPoliciesRoutes,
  ...zeroModelProvidersRoutes,
  ...zeroMeModelProvidersDeleteRoutes,
  ...zeroMeModelProvidersListRoutes,
  ...zeroMeModelProvidersUpsertRoutes,
  ...zeroVoiceIoQuotaRoutes,
  ...zeroVoiceIoSpeechRoutes,
  ...zeroVoiceIoSttRoutes,
  ...zeroWebDownloadRoutes,
  ...zeroQueuePositionRoutes,
  ...zeroRealtimeTokenRoutes,
  ...zeroReportErrorRoutes,
  ...zeroRunDetailRoutes,
  ...zeroRunsRoutes,
  ...zeroRunsCancelRoutes,
  ...zeroOnboardingCompleteLimitedFreeRoutes,
  ...zeroOnboardingSetupRoutes,
  ...zeroOnboardingStatusRoutes,
  ...zeroOrgInviteRoutes,
  ...zeroOrgDeleteRoutes,
  ...zeroOrgLogoRoutes,
  ...zeroOrgMembersRoutes,
  ...zeroOrgMembershipRequestsRoutes,
  ...zeroOrgReadRoutes,
  ...zeroPushSubscriptionsRoutes,
  ...zeroUserPermissionGrantsRoutes,
  ...zeroUserPreferencesRoutes,
  ...zeroUserModelPreferenceRoutes,
  ...zeroSecretsRoutes,
  ...zeroWorkflowsRoutes,
  ...zeroWorkflowTriggersRoutes,
  ...integrationsGithubRoutes,
  ...zeroSlackBrowserConnectRoutes,
  ...zeroSlackConnectRoutes,
  ...zeroSlackOauthRoutes,
  ...zeroSlackCommandsRoutes,
  ...zeroSlackEventsRoutes,
  ...zeroSlackInteractiveRoutes,
  ...zeroTeamsBrowserConnectRoutes,
  ...zeroTeamsBotRoutes,
  ...zeroTeamsConnectRoutes,
  ...zeroIntegrationsAgentPhoneRoutes,
  ...zeroIntegrationsPhoneDownloadFileRoutes,
  ...zeroIntegrationsPhoneMessageRoutes,
  ...zeroIntegrationsPhoneUploadCompleteRoutes,
  ...zeroIntegrationsPhoneUploadInitRoutes,
  ...zeroIntegrationsGithubDownloadFileRoutes,
  ...zeroIntegrationsGithubUploadCompleteRoutes,
  ...zeroIntegrationsGithubUploadInitRoutes,
  ...zeroIntegrationsSlackRoutes,
  ...zeroIntegrationsSlackMessageRoutes,
  ...zeroIntegrationsSlackUploadCompleteRoutes,
  ...zeroIntegrationsSlackUploadInitRoutes,
  ...zeroSlackChannelsRoutes,
  ...zeroIntegrationsTelegramRoutes,
  ...zeroIntegrationsTelegramMessageRoutes,
  ...zeroIntegrationsTelegramUploadCompleteRoutes,
  ...zeroIntegrationsTelegramUploadInitRoutes,
  ...zeroTeamRoutes,
  ...zeroUploadsCompleteRoutes,
  ...zeroUploadsHtmlDomEditSnapshotRoutes,
  ...zeroUploadsPrepareRoutes,
  ...registryResourceDownloadRoutes,
  ...storagesCommitRoutes,
  ...storagesDownloadRoutes,
  ...storagesListRoutes,
  ...storagesPrepareRoutes,
  ...zeroUsageInsightRoutes,
  ...zeroUsageMembersRoutes,
  ...zeroUsageRecordRoutes,
  ...zeroUsageRunsRoutes,
  ...chatThreadsV1Routes,
  ...audioTranscriptionsV1Routes,
  ...modelStatsRoutes,
  ...presentationImagesRoutes,
  ...runnersRoutes,
  ...testOAuthProviderAuthorizeRoutes,
  ...testOAuthProviderDeviceAuthRoutes,
  ...testOAuthProviderEchoRoutes,
  ...testOAuthProviderTokenRoutes,
  ...testOAuthProviderUserinfoRoutes,
  ...testSlackDispatchProbeRoutes,
  ...testSlackMockRoutes,
  ...testSlackStateRoutes,
  ...testEmailStateRoutes,
  ...testBillingRedeemStateRoutes,
  ...testBillingStatusStateRoutes,
  ...testTelegramDispatchProbeRoutes,
  ...testTelegramMockRoutes,
  ...testTelegramStateRoutes,
  ...testGenerationStateRoutes,
  ...testOnboardingStatusStateRoutes,
  ...testMemoryStateRoutes,
  ...testUsageInsightStateRoutes,
  ...testUsageStateRoutes,
  ...testUserExportStateRoutes,
  ...testWorkflowTriggerStateRoutes,
  ...testChatMessagesStateRoutes,
  ...testWebhooksStateRoutes,
];
