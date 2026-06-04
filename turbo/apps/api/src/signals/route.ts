import type { AppRoute } from "@ts-rest/core";
import { healthContract } from "@vm0/api-contracts/contracts/health";

import { agentCheckpointsRoutes } from "./routes/agent-checkpoints-id";
import { agentComposesByIdRoutes } from "./routes/agent-composes-id";
import { agentComposesMetadataRoutes } from "./routes/agent-composes-metadata";
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
import type { SignalRouteHandler } from "./context/route";
import { chatThreadsV1Routes } from "./routes/chat-threads-v1";
import { connectorsTypeCallbackRoutes } from "./routes/connectors-type-callback";
import { cronAggregateInsightsRoutes } from "./routes/cron-aggregate-insights";
import { cronAggregateUsageRoutes } from "./routes/cron-aggregate-usage";
import { cronCleanupSandboxesRoutes } from "./routes/cron-cleanup-sandboxes";
import { cronDrainEmailOutboxRoutes } from "./routes/cron-drain-email-outbox";
import { cronExecuteSchedulesRoutes } from "./routes/cron-execute-schedules";
import { cronProcessUsageEventsRoutes } from "./routes/cron-process-usage-events";
import { cronReconcileBillingEntitlementsRoutes } from "./routes/cron-reconcile-billing-entitlements";
import { cronComputerUseScreenshotCleanupRoutes } from "./routes/cron-computer-use-screenshot-cleanup";
import { cronSummarizeMemoryRoutes } from "./routes/cron-summarize-memory";
import { cronSyncSkillsRoutes } from "./routes/cron-sync-skills";
import { cronTelegramCleanupRoutes } from "./routes/cron-telegram-cleanup";
import { deviceTokenRoutes } from "./routes/device-token";
import { desktopAuthRoutes } from "./routes/desktop-auth";
import { emailUnsubscribeRoutes } from "./routes/email-unsubscribe";
import { generateImageRoutes } from "./routes/generate-image";
import { apiHealth$ } from "./routes/health";
import { healthAuthProbeRoutes } from "./routes/health-auth-probe";
import { githubOauthRoutes } from "./routes/github-oauth";
import { internalCallbacksAgentRoutes } from "./routes/internal-callbacks-agent";
import { internalCallbacksAgentPhoneRoutes } from "./routes/internal-callbacks-agentphone";
import { internalCallbacksChatRoutes } from "./routes/internal-callbacks-chat";
import { internalCallbacksGithubIssuesRoutes } from "./routes/internal-callbacks-github-issues";
import { internalCallbacksScheduleRoutes } from "./routes/internal-callbacks-schedule";
import { internalCallbacksSlackOrgRoutes } from "./routes/internal-callbacks-slack-org";
import { internalCallbacksTelegramRoutes } from "./routes/internal-callbacks-telegram";
import { internalEventConsumerAgentPhoneTypingRoutes } from "./routes/internal-event-consumers-agentphone-typing";
import { internalEventConsumerAxiomRoutes } from "./routes/internal-event-consumers-axiom";
import { internalEventConsumerChatAssistantRoutes } from "./routes/internal-event-consumers-chat-assistant";
import { internalEventConsumerTelegramTypingRoutes } from "./routes/internal-event-consumers-telegram-typing";
import { legacyFileRoutes } from "./routes/legacy-file";
import { logsSearchRoutes } from "./routes/logs-search";
import { modelStatsRoutes } from "./routes/model-stats";
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
import { webhooksStripeRoutes } from "./routes/webhooks-stripe";
import { zeroAgentInstructionsRoutes } from "./routes/zero-agent-instructions";
import { zeroAgentsRoutes } from "./routes/zero-agents";
import { zeroApiKeysRoutes } from "./routes/zero-api-keys";
import { zeroAttributionRoutes } from "./routes/zero-attribution";
import { zeroBillingAutoRechargeRoutes } from "./routes/zero-billing-auto-recharge";
import { zeroBillingCheckoutRoutes } from "./routes/zero-billing-checkout";
import { zeroBillingCreditCheckoutRoutes } from "./routes/zero-billing-credit-checkout";
import { zeroBillingDowngradeRoutes } from "./routes/zero-billing-downgrade";
import { zeroBillingInvoicesRoutes } from "./routes/zero-billing-invoices";
import { zeroBillingPortalRoutes } from "./routes/zero-billing-portal";
import { zeroBillingRedeemRoutes } from "./routes/zero-billing-redeem";
import { zeroBillingStatusRoutes } from "./routes/zero-billing-status";
import { zeroBankingRoutes } from "./routes/zero-banking";
import { zeroChatThreadRoutes } from "./routes/zero-chat-threads";
import { zeroChatMessagesRoutes } from "./routes/zero-chat-messages";
import { zeroClaudeCodeDeviceAuthRoutes } from "./routes/zero-claude-code-device-auth";
import { zeroComposesRoutes } from "./routes/zero-composes";
import { zeroComputerUseRoutes } from "./routes/zero-computer-use";
import { zeroCodexDeviceAuthRoutes } from "./routes/zero-codex-device-auth";
import { zeroConnectorsOauthDeviceAuthRoutes } from "./routes/zero-connectors-oauth-device-auth";
import { zeroConnectorsRoutes } from "./routes/zero-connectors";
import { zeroCustomConnectorsRoutes } from "./routes/zero-custom-connectors";
import { zeroDefaultAgentRoutes } from "./routes/zero-default-agent";
import { zeroDeveloperSupportRoutes } from "./routes/zero-developer-support";
import { zeroEmailCallbackRoutes } from "./routes/zero-email-callbacks";
import { zeroEmailInboundRoutes } from "./routes/zero-email-inbound";
import { zeroFeatureSwitchesRoutes } from "./routes/zero-feature-switches";
import { zeroHostRoutes } from "./routes/zero-host";
import { zeroMemoryRoutes } from "./routes/zero-memory";
import { zeroMemoryActivityRoutes } from "./routes/zero-memory-activity";
import { zeroBuiltInGenerationRoutes } from "./routes/zero-built-in-generation";
import { zeroInsightsRoutes } from "./routes/zero-insights";
import { zeroImageIoGenerateRoutes } from "./routes/zero-image-io-generate";
import { zeroLogsRoutes } from "./routes/zero-logs";
import { zeroMapsRoutes } from "./routes/zero-maps";
import { zeroModelPoliciesRoutes } from "./routes/zero-model-policies";
import { zeroModelProvidersRoutes } from "./routes/zero-model-providers";
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
import { zeroSchedulesRoutes } from "./routes/zero-schedules";
import { zeroMeModelProvidersDeleteRoutes } from "./routes/zero-me-model-providers-delete";
import { zeroMeModelProvidersListRoutes } from "./routes/zero-me-model-providers-list";
import { zeroMeModelProvidersUpsertRoutes } from "./routes/zero-me-model-providers-upsert";
import { zeroSecretsRoutes } from "./routes/zero-secrets";
import { zeroSkillsRoutes } from "./routes/zero-skills";
import { integrationsGithubRoutes } from "./routes/integrations-github";
import { zeroIntegrationsChatMessageRoutes } from "./routes/zero-integrations-chat-message";
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
import { zeroTeamRoutes } from "./routes/zero-team";
import { zeroUploadsCompleteRoutes } from "./routes/zero-uploads-complete";
import { zeroUploadsPrepareRoutes } from "./routes/zero-uploads-prepare";
import { zeroUsageInsightRoutes } from "./routes/zero-usage-insight";
import { zeroUsageMembersRoutes } from "./routes/zero-usage-members";
import { zeroUsageRunsRoutes } from "./routes/zero-usage-runs";
import { zeroUserPreferencesRoutes } from "./routes/zero-user-preferences";
import { zeroUserPermissionGrantsRoutes } from "./routes/zero-user-permission-grants";
import { zeroUserModelPreferenceRoutes } from "./routes/zero-user-model-preference";
import { zeroVoiceIoQuotaRoutes } from "./routes/zero-voice-io-quota";
import { zeroVoiceIoSpeechRoutes } from "./routes/zero-voice-io-speech";
import { zeroVoiceIoSttRoutes } from "./routes/zero-voice-io-stt";
import { zeroVoiceIoTtsRoutes } from "./routes/zero-voice-io-tts";
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
import { testTelegramDispatchProbeRoutes } from "./routes/test-telegram-dispatch-probe";
import { testTelegramMockRoutes } from "./routes/test-telegram-mock";
import { testTelegramStateRoutes } from "./routes/test-telegram-state";

export type { SignalRouteHandler };

export interface RouteEntry {
  readonly route: AppRoute;
  readonly handler: SignalRouteHandler<unknown>;
}

export const ROUTES: readonly RouteEntry[] = [
  {
    route: healthContract.check,
    handler: apiHealth$,
  },
  ...authMeRoutes,
  ...cliAuthRoutes,
  ...cliAuthTestRoutes,
  ...desktopAuthRoutes,
  ...healthAuthProbeRoutes,
  ...githubOauthRoutes,
  ...internalCallbacksAgentRoutes,
  ...internalCallbacksAgentPhoneRoutes,
  ...internalCallbacksChatRoutes,
  ...internalCallbacksGithubIssuesRoutes,
  ...internalCallbacksScheduleRoutes,
  ...internalCallbacksSlackOrgRoutes,
  ...internalCallbacksTelegramRoutes,
  ...internalEventConsumerAgentPhoneTypingRoutes,
  ...internalEventConsumerAxiomRoutes,
  ...internalEventConsumerChatAssistantRoutes,
  ...internalEventConsumerTelegramTypingRoutes,
  ...legacyFileRoutes,
  ...logsSearchRoutes,
  ...usageRoutes,
  ...userExportRoutes,
  ...webhooksClerkRoutes,
  ...webhooksBuiltInGenerationRoutes,
  ...webhooksGithubRoutes,
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
  ...agentComposesMetadataRoutes,
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
  ...cronExecuteSchedulesRoutes,
  ...cronProcessUsageEventsRoutes,
  ...cronReconcileBillingEntitlementsRoutes,
  ...cronComputerUseScreenshotCleanupRoutes,
  ...cronSummarizeMemoryRoutes,
  ...cronSyncSkillsRoutes,
  ...cronTelegramCleanupRoutes,
  ...deviceTokenRoutes,
  ...emailUnsubscribeRoutes,
  ...generateImageRoutes,
  ...zeroAgentInstructionsRoutes,
  ...zeroAgentsRoutes,
  ...zeroApiKeysRoutes,
  ...zeroAttributionRoutes,
  ...zeroBillingAutoRechargeRoutes,
  ...zeroBillingCheckoutRoutes,
  ...zeroBillingCreditCheckoutRoutes,
  ...zeroBillingDowngradeRoutes,
  ...zeroBillingInvoicesRoutes,
  ...zeroBillingPortalRoutes,
  ...zeroBillingRedeemRoutes,
  ...zeroBillingStatusRoutes,
  ...zeroBankingRoutes,
  ...zeroChatThreadRoutes,
  ...zeroChatMessagesRoutes,
  ...zeroClaudeCodeDeviceAuthRoutes,
  ...zeroComposesRoutes,
  ...zeroComputerUseRoutes,
  ...zeroCodexDeviceAuthRoutes,
  ...zeroConnectorsOauthDeviceAuthRoutes,
  ...zeroConnectorsRoutes,
  ...zeroCustomConnectorsRoutes,
  ...zeroDefaultAgentRoutes,
  ...zeroDeveloperSupportRoutes,
  ...zeroEmailCallbackRoutes,
  ...zeroEmailInboundRoutes,
  ...zeroFeatureSwitchesRoutes,
  ...zeroHostRoutes,
  ...zeroMemoryRoutes,
  ...zeroMemoryActivityRoutes,
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
  ...zeroVoiceIoTtsRoutes,
  ...zeroWebDownloadRoutes,
  ...zeroQueuePositionRoutes,
  ...zeroRealtimeTokenRoutes,
  ...zeroReportErrorRoutes,
  ...zeroRunDetailRoutes,
  ...zeroRunsRoutes,
  ...zeroRunsCancelRoutes,
  ...zeroSchedulesRoutes,
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
  ...zeroSkillsRoutes,
  ...integrationsGithubRoutes,
  ...zeroSlackBrowserConnectRoutes,
  ...zeroSlackConnectRoutes,
  ...zeroSlackOauthRoutes,
  ...zeroSlackCommandsRoutes,
  ...zeroSlackEventsRoutes,
  ...zeroSlackInteractiveRoutes,
  ...zeroIntegrationsAgentPhoneRoutes,
  ...zeroIntegrationsPhoneDownloadFileRoutes,
  ...zeroIntegrationsPhoneMessageRoutes,
  ...zeroIntegrationsPhoneUploadCompleteRoutes,
  ...zeroIntegrationsPhoneUploadInitRoutes,
  ...zeroIntegrationsGithubDownloadFileRoutes,
  ...zeroIntegrationsGithubUploadCompleteRoutes,
  ...zeroIntegrationsGithubUploadInitRoutes,
  ...zeroIntegrationsChatMessageRoutes,
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
  ...zeroUploadsPrepareRoutes,
  ...storagesCommitRoutes,
  ...storagesDownloadRoutes,
  ...storagesListRoutes,
  ...storagesPrepareRoutes,
  ...zeroUsageInsightRoutes,
  ...zeroUsageMembersRoutes,
  ...zeroUsageRunsRoutes,
  ...chatThreadsV1Routes,
  ...audioTranscriptionsV1Routes,
  ...modelStatsRoutes,
  ...runnersRoutes,
  ...testOAuthProviderAuthorizeRoutes,
  ...testOAuthProviderDeviceAuthRoutes,
  ...testOAuthProviderEchoRoutes,
  ...testOAuthProviderTokenRoutes,
  ...testOAuthProviderUserinfoRoutes,
  ...testSlackDispatchProbeRoutes,
  ...testSlackMockRoutes,
  ...testSlackStateRoutes,
  ...testTelegramDispatchProbeRoutes,
  ...testTelegramMockRoutes,
  ...testTelegramStateRoutes,
];
