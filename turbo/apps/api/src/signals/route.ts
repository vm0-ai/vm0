import { authMeRoutes } from "./routes/auth-me";
import { cliAuthRoutes } from "./routes/cli-auth";
import type { RouteEntry } from "./route-entry";
import { connectorsSlugCallbackRoutes } from "./routes/connectors-slug-callback";
import { cronCompactChatThreadSnapshotsRoutes } from "./routes/cron-compact-chat-thread-snapshots";
import { cronProjectChatEventSearchRoutes } from "./routes/cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "./routes/cron-snapshot-chat-events";
import { cronCompactUsageEventsRoutes } from "./routes/cron-compact-usage-events";
import { cronCleanupSandboxesRoutes } from "./routes/cron-cleanup-sandboxes";
import { cronConnectorCatalogRoutes } from "./routes/cron-connector-catalog";
import { cronConnectorOauthStateCleanupRoutes } from "./routes/cron-connector-oauth-state-cleanup";
import { cronDrainEmailOutboxRoutes } from "./routes/cron-drain-email-outbox";
import { cronExecuteMorningBriefsRoutes } from "./routes/cron-execute-morning-briefs";
import { cronExecuteWorkflowAutomationsRoutes } from "./routes/cron-execute-workflow-automations";
import { cronMonitorChatEventQueueRoutes } from "./routes/cron-monitor-chat-event-queue";
import { cronRenewGmailWatchesRoutes } from "./routes/cron-renew-gmail-watches";
import { cronRenewGoogleFormsWatchesRoutes } from "./routes/cron-renew-google-forms-watches";
import { cronRenewGoogleCalendarWatchesRoutes } from "./routes/cron-renew-google-calendar-watches";
import { cronRenewGoogleWorkspaceEventSubscriptionsRoutes } from "./routes/cron-renew-google-workspace-event-subscriptions";
import { cronProcessUsageEventsRoutes } from "./routes/cron-process-usage-events";
import { cronReconcileBillingEntitlementsRoutes } from "./routes/cron-reconcile-billing-entitlements";
import { cronRefreshStoragePresignedUrlsRoutes } from "./routes/cron-refresh-storage-presigned-urls";
import { cronComputerUseScreenshotCleanupRoutes } from "./routes/cron-computer-use-screenshot-cleanup";
import { cronBrowserReconcileRoutes } from "./routes/cron-browser-reconcile";
import { cronSteerRunTimeBudgetRoutes } from "./routes/cron-steer-run-time-budget";
import { cronSyncSkillsRoutes } from "./routes/cron-sync-skills";
import { cronTelegramCleanupRoutes } from "./routes/cron-telegram-cleanup";
import { desktopAuthRoutes } from "./routes/desktop-auth";
import { desktopUpdateRoutes } from "./routes/desktop-updates";
import { emailMorningBriefUnsubscribeRoutes } from "./routes/email-morning-brief-unsubscribe";
import { morningBriefRoutes } from "./routes/morning-brief";
import { emailUnsubscribeRoutes } from "./routes/email-unsubscribe";
import { healthRoutes } from "./routes/health";
import { buildInfoRoutes } from "./routes/build-info";
import { healthAuthProbeRoutes } from "./routes/health-auth-probe";
import { githubOauthRoutes } from "./routes/github-oauth";
import { modelStatsRoutes } from "./routes/model-stats";
import { presentationImagesRoutes } from "./routes/presentation-images";
import { registryResourceDownloadRoutes } from "./routes/registry-resources-download";
import { runnersRoutes } from "./routes/runners";
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
import { webhooksGoogleFormsRoutes } from "./routes/webhooks-google-forms";
import { webhooksGoogleCalendarRoutes } from "./routes/webhooks-google-calendar";
import { webhooksGoogleWorkspaceEventsRoutes } from "./routes/webhooks-google-workspace-events";
import { webhooksNotionRoutes } from "./routes/webhooks-notion";
import { webhooksWorkflowAutomationsRoutes } from "./routes/webhooks-workflow-automations";
import { webhooksStripeRoutes } from "./routes/webhooks-stripe";
import { webhooksStripeAutomationEventsRoutes } from "./routes/webhooks-stripe-automation-events";
import { agentDraftRoutes } from "./routes/agent-draft";
import { zeroAgentInstructionsRoutes } from "./routes/zero-agent-instructions";
import { zeroAgentsRoutes } from "./routes/zero-agents";
import { artifactCatalogRoutes } from "./routes/artifact-catalog";
import { acquisitionAttributionRoutes } from "./routes/acquisition-attribution";
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
import { zeroBillingUsagePackCreditsRoutes } from "./routes/zero-billing-usage-pack-credits";
import { zeroBankingRoutes } from "./routes/zero-banking";
import { zeroChatThreadRoutes } from "./routes/zero-chat-threads";
import { zeroChatEventsRoutes } from "./routes/zero-chat-events";
import { sharedThreadRoutes } from "./routes/shared-threads";
import { claudeCodeDeviceAuthRoutes } from "./routes/claude-code-device-auth";
import { zeroComposesRoutes } from "./routes/zero-composes";
import { zeroComputerUseAuthorizationRoutes } from "./routes/zero-computer-use-authorization";
import { zeroComputerUseRoutes } from "./routes/zero-computer-use";
import { codexDeviceAuthRoutes } from "./routes/codex-device-auth";
import { zeroConnectorCatalogRoutes } from "./routes/zero-connector-catalog";
import { connectorCheckRoutes } from "./routes/connector-check";
import { zeroConnectorsExternalCodeRoutes } from "./routes/zero-connectors-external-code";
import { zeroConnectorsOauthDeviceAuthRoutes } from "./routes/zero-connectors-oauth-device-auth";
import { zeroConnectorsRoutes } from "./routes/zero-connectors";
import { zeroCustomConnectorsRoutes } from "./routes/zero-custom-connectors";
import { zeroEmailInboundRoutes } from "./routes/zero-email-inbound";
import { zeroFeatureSwitchesRoutes } from "./routes/zero-feature-switches";
import { financeRoutes } from "./routes/finance";
import { zeroSeoRoutes } from "./routes/zero-seo";
import { zeroGoalsRoutes } from "./routes/zero-goals";
import { zeroHostRoutes } from "./routes/zero-host";
import { builtInGenerationRoutes } from "./routes/built-in-generation";
import { zeroImageIoGenerateRoutes } from "./routes/zero-image-io-generate";
import { imageShareXRoutes } from "./routes/image-share-x";
import { logsRoutes } from "./routes/logs";
import { zeroMailRoutes } from "./routes/zero-mail";
import { mapsRoutes } from "./routes/maps";
import { mcpConnectorsRoutes } from "./routes/mcp-connectors";
import { weatherRoutes } from "./routes/weather";
import { zeroModelPoliciesRoutes } from "./routes/zero-model-policies";
import { zeroModelProviderGatewayRoutes } from "./routes/zero-model-provider-gateways";
import { zeroModelProvidersRoutes } from "./routes/zero-model-providers";
import { onboardingCompleteRoutes } from "./routes/onboarding-complete";
import { onboardingStatusRoutes } from "./routes/onboarding-status";
import { zeroOrgInviteRoutes } from "./routes/zero-org-invite";
import { zeroOrgDeleteRoutes } from "./routes/zero-org-delete";
import { orgLogoRoutes } from "./routes/org-logo";
import { zeroOrgMembersRoutes } from "./routes/zero-org-members";
import { zeroOrgMembershipRequestsRoutes } from "./routes/zero-org-membership-requests";
import { zeroOrgReadRoutes } from "./routes/zero-org-read";
import { pushSubscriptionsRoutes } from "./routes/push-subscriptions";
import { queuePositionRoutes } from "./routes/queue-position";
import { realtimeTokenRoutes } from "./routes/realtime-token";
import { imageRecognitionRoutes } from "./routes/image-recognition";
import { translationRoutes } from "./routes/translation";
import { zeroRunDetailRoutes } from "./routes/zero-run-detail";
import { zeroRunsRoutes } from "./routes/zero-runs";
import { zeroRunsCancelRoutes } from "./routes/zero-runs-cancel";
import { zeroMeModelProvidersDeleteRoutes } from "./routes/zero-me-model-providers-delete";
import { zeroMeModelProviderAccountRoutes } from "./routes/zero-me-model-provider-accounts";
import { zeroMeModelProvidersListRoutes } from "./routes/zero-me-model-providers-list";
import { zeroMeModelProvidersResetSubscriptionRoutes } from "./routes/zero-me-model-providers-reset-subscription";
import { zeroMeModelProvidersUpsertRoutes } from "./routes/zero-me-model-providers-upsert";
import { scrapeRoutes } from "./routes/scrape";
import { peopleSearchRoutes } from "./routes/people-search";
import { webSearchRoutes } from "./routes/web-search";
import { zeroBrowserRoutes } from "./routes/zero-browser";
import { zeroBrowserAuthorizationRoutes } from "./routes/zero-browser-authorization";
import { zeroWorkflowsRoutes } from "./routes/zero-workflows";
import { zeroWorkflowAutomationsRoutes } from "./routes/zero-workflow-automations";
import { strapiIntegrationsRoutes } from "./routes/strapi-integrations";
import { strapiEventsRoutes } from "./routes/strapi-events";
import { integrationsGithubRoutes } from "./routes/integrations-github";
import { zeroIntegrationsAgentPhoneRoutes } from "./routes/zero-integrations-agentphone";
import { zeroIntegrationsPhoneDownloadFileRoutes } from "./routes/zero-integrations-phone-download-file";
import { zeroIntegrationsPhoneMessageRoutes } from "./routes/zero-integrations-phone-message";
import { zeroIntegrationsPhoneUploadCompleteRoutes } from "./routes/zero-integrations-phone-upload-complete";
import { integrationsPhoneUploadInitRoutes } from "./routes/integrations-phone-upload-init";
import { zeroIntegrationsGithubDownloadFileRoutes } from "./routes/zero-integrations-github-download-file";
import { zeroIntegrationsGithubUploadCompleteRoutes } from "./routes/zero-integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "./routes/integrations-github-upload-init";
import { zeroIntegrationsFeishuFileRoutes } from "./routes/zero-integrations-feishu-files";
import { zeroIntegrationsSlackRoutes } from "./routes/zero-integrations-slack";
import { zeroIntegrationsSlackMessageRoutes } from "./routes/zero-integrations-slack-message";
import { zeroIntegrationsFeishuMessageRoutes } from "./routes/zero-integrations-feishu-message";
import { zeroIntegrationsSlackUploadCompleteRoutes } from "./routes/zero-integrations-slack-upload-complete";
import { zeroIntegrationsSlackUploadInitRoutes } from "./routes/zero-integrations-slack-upload-init";
import { zeroIntegrationsSlackUploadMaterializeRoutes } from "./routes/zero-integrations-slack-upload-materialize";
import { zeroIntegrationsTeamsDownloadFileRoutes } from "./routes/zero-integrations-teams-download-file";
import { zeroIntegrationsTeamsMessageRoutes } from "./routes/zero-integrations-teams-message";
import { zeroIntegrationsTeamsUploadCompleteRoutes } from "./routes/zero-integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "./routes/integrations-teams-upload-init";
import { zeroIntegrationsTelegramRoutes } from "./routes/zero-integrations-telegram";
import { zeroIntegrationsTelegramMessageRoutes } from "./routes/zero-integrations-telegram-message";
import { zeroIntegrationsTelegramUploadCompleteRoutes } from "./routes/zero-integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "./routes/integrations-telegram-upload-init";
import { zeroSlackChannelsRoutes } from "./routes/zero-slack-channels";
import { slackCommandsRoutes } from "./routes/slack-commands";
import { zeroSlackConnectRoutes } from "./routes/zero-slack-connect";
import { slackEventsRoutes } from "./routes/slack-events";
import { slackInteractiveRoutes } from "./routes/slack-interactive";
import { zeroSlackOauthRoutes } from "./routes/zero-slack-oauth";
import { zeroFeishuBrowserConnectRoutes } from "./routes/zero-feishu-browser-connect";
import { zeroFeishuConnectRoutes } from "./routes/zero-feishu-connect";
import { feishuEventsRoutes } from "./routes/feishu-events";
import { zeroFeishuOauthRoutes } from "./routes/zero-feishu-oauth";
import { steamPlayerRoutes } from "./routes/steam-player";
import { zeroTeamsBrowserConnectRoutes } from "./routes/zero-teams-browser-connect";
import { zeroTeamsBotRoutes } from "./routes/zero-teams-bot";
import { zeroTeamsConnectRoutes } from "./routes/zero-teams-connect";
import { zeroTeamsOauthRoutes } from "./routes/zero-teams-oauth";
import { zeroTeamRoutes } from "./routes/zero-team";
import { zeroUploadsCompleteRoutes } from "./routes/zero-uploads-complete";
import { zeroUploadsMultipartRoutes } from "./routes/zero-uploads-multipart";
import { zeroUploadsPrepareRoutes } from "./routes/zero-uploads-prepare";
import { zeroUsageMembersRoutes } from "./routes/zero-usage-members";
import { zeroUsageRecordRoutes } from "./routes/zero-usage-record";
import { userPreferencesRoutes } from "./routes/user-preferences";
import { zeroUserPermissionGrantsRoutes } from "./routes/zero-user-permission-grants";
import { userModelPreferenceRoutes } from "./routes/user-model-preference";
import { zeroAvatarVideoRoutes } from "./routes/zero-avatar-video";
import { voiceIoQuotaRoutes } from "./routes/voice-io-quota";
import { voiceIoSpeechRoutes } from "./routes/voice-io-speech";
import { voiceIoSttRoutes } from "./routes/voice-io-stt";
import { zeroVideoIoGenerateRoutes } from "./routes/zero-video-io-generate";
import { webDownloadRoutes } from "./routes/web-download";
import { webFileUrlRoutes } from "./routes/web-file-url";

export const ROUTES: readonly RouteEntry[] = [
  ...healthRoutes,
  ...buildInfoRoutes,
  ...authMeRoutes,
  ...cliAuthRoutes,
  ...desktopAuthRoutes,
  ...desktopUpdateRoutes,
  ...healthAuthProbeRoutes,
  ...githubOauthRoutes,
  ...userExportRoutes,
  ...webhooksClerkRoutes,
  ...webhooksBuiltInGenerationRoutes,
  ...webhooksGithubRoutes,
  ...webhooksGmailRoutes,
  ...webhooksGoogleFormsRoutes,
  ...webhooksGoogleCalendarRoutes,
  ...webhooksGoogleWorkspaceEventsRoutes,
  ...webhooksNotionRoutes,
  ...webhooksWorkflowAutomationsRoutes,
  ...strapiEventsRoutes,
  ...webhooksStripeRoutes,
  ...webhooksStripeAutomationEventsRoutes,
  ...webhooksAgentHealthUsageTelemetryRoutes,
  ...webhooksAgentCheckpointsRoutes,
  ...webhooksAgentCompleteRoutes,
  ...webhooksAgentEventsRoutes,
  ...webhooksAgentFirewallAuthRoutes,
  ...webhooksAgentStorageRoutes,
  ...connectorsSlugCallbackRoutes,
  ...cronCompactChatThreadSnapshotsRoutes,
  ...cronProjectChatEventSearchRoutes,
  ...cronSnapshotChatEventsRoutes,
  ...cronCompactUsageEventsRoutes,
  ...cronCleanupSandboxesRoutes,
  ...cronConnectorCatalogRoutes,
  ...cronConnectorOauthStateCleanupRoutes,
  ...cronDrainEmailOutboxRoutes,
  ...cronExecuteMorningBriefsRoutes,
  ...cronExecuteWorkflowAutomationsRoutes,
  ...cronMonitorChatEventQueueRoutes,
  ...cronRenewGmailWatchesRoutes,
  ...cronRenewGoogleFormsWatchesRoutes,
  ...cronRenewGoogleCalendarWatchesRoutes,
  ...cronRenewGoogleWorkspaceEventSubscriptionsRoutes,
  ...cronProcessUsageEventsRoutes,
  ...cronReconcileBillingEntitlementsRoutes,
  ...cronRefreshStoragePresignedUrlsRoutes,
  ...cronComputerUseScreenshotCleanupRoutes,
  ...cronBrowserReconcileRoutes,
  ...cronSteerRunTimeBudgetRoutes,
  ...cronSyncSkillsRoutes,
  ...cronTelegramCleanupRoutes,
  ...emailMorningBriefUnsubscribeRoutes,
  ...morningBriefRoutes,
  ...emailUnsubscribeRoutes,
  ...agentDraftRoutes,
  ...zeroAgentInstructionsRoutes,
  ...zeroAgentsRoutes,
  ...artifactCatalogRoutes,
  ...acquisitionAttributionRoutes,
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
  ...zeroBillingUsagePackCreditsRoutes,
  ...zeroBankingRoutes,
  ...zeroChatThreadRoutes,
  ...zeroChatEventsRoutes,
  ...sharedThreadRoutes,
  ...claudeCodeDeviceAuthRoutes,
  ...zeroComposesRoutes,
  ...zeroComputerUseAuthorizationRoutes,
  ...zeroComputerUseRoutes,
  ...codexDeviceAuthRoutes,
  ...zeroConnectorCatalogRoutes,
  ...connectorCheckRoutes,
  ...zeroConnectorsExternalCodeRoutes,
  ...zeroConnectorsOauthDeviceAuthRoutes,
  ...zeroConnectorsRoutes,
  ...zeroCustomConnectorsRoutes,
  ...zeroEmailInboundRoutes,
  ...zeroFeatureSwitchesRoutes,
  ...financeRoutes,
  ...zeroSeoRoutes,
  ...zeroGoalsRoutes,
  ...zeroHostRoutes,
  ...builtInGenerationRoutes,
  ...zeroImageIoGenerateRoutes,
  ...imageShareXRoutes,
  ...zeroAvatarVideoRoutes,
  ...zeroVideoIoGenerateRoutes,
  ...logsRoutes,
  ...zeroMailRoutes,
  ...mapsRoutes,
  ...mcpConnectorsRoutes,
  ...weatherRoutes,
  ...scrapeRoutes,
  ...peopleSearchRoutes,
  ...webSearchRoutes,
  ...zeroBrowserRoutes,
  ...zeroBrowserAuthorizationRoutes,
  ...zeroModelPoliciesRoutes,
  ...zeroModelProviderGatewayRoutes,
  ...zeroModelProvidersRoutes,
  ...zeroMeModelProvidersDeleteRoutes,
  ...zeroMeModelProviderAccountRoutes,
  ...zeroMeModelProvidersListRoutes,
  ...zeroMeModelProvidersResetSubscriptionRoutes,
  ...zeroMeModelProvidersUpsertRoutes,
  ...voiceIoQuotaRoutes,
  ...voiceIoSpeechRoutes,
  ...voiceIoSttRoutes,
  ...webDownloadRoutes,
  ...webFileUrlRoutes,
  ...queuePositionRoutes,
  ...realtimeTokenRoutes,
  ...imageRecognitionRoutes,
  ...translationRoutes,
  ...zeroRunDetailRoutes,
  ...zeroRunsRoutes,
  ...zeroRunsCancelRoutes,
  ...onboardingCompleteRoutes,
  ...onboardingStatusRoutes,
  ...zeroOrgInviteRoutes,
  ...zeroOrgDeleteRoutes,
  ...orgLogoRoutes,
  ...zeroOrgMembersRoutes,
  ...zeroOrgMembershipRequestsRoutes,
  ...zeroOrgReadRoutes,
  ...pushSubscriptionsRoutes,
  ...zeroUserPermissionGrantsRoutes,
  ...userPreferencesRoutes,
  ...userModelPreferenceRoutes,
  ...zeroWorkflowsRoutes,
  ...zeroWorkflowAutomationsRoutes,
  ...strapiIntegrationsRoutes,
  ...integrationsGithubRoutes,
  ...zeroSlackConnectRoutes,
  ...zeroSlackOauthRoutes,
  ...slackCommandsRoutes,
  ...slackEventsRoutes,
  ...slackInteractiveRoutes,
  ...zeroFeishuBrowserConnectRoutes,
  ...zeroFeishuConnectRoutes,
  ...feishuEventsRoutes,
  ...zeroFeishuOauthRoutes,
  ...zeroTeamsBrowserConnectRoutes,
  ...zeroTeamsBotRoutes,
  ...zeroTeamsConnectRoutes,
  ...zeroTeamsOauthRoutes,
  ...zeroIntegrationsAgentPhoneRoutes,
  ...zeroIntegrationsPhoneDownloadFileRoutes,
  ...zeroIntegrationsPhoneMessageRoutes,
  ...zeroIntegrationsPhoneUploadCompleteRoutes,
  ...integrationsPhoneUploadInitRoutes,
  ...zeroIntegrationsGithubDownloadFileRoutes,
  ...zeroIntegrationsGithubUploadCompleteRoutes,
  ...integrationsGithubUploadInitRoutes,
  ...zeroIntegrationsFeishuFileRoutes,
  ...zeroIntegrationsSlackRoutes,
  ...zeroIntegrationsSlackMessageRoutes,
  ...zeroIntegrationsFeishuMessageRoutes,
  ...zeroIntegrationsSlackUploadCompleteRoutes,
  ...zeroIntegrationsSlackUploadInitRoutes,
  ...zeroIntegrationsSlackUploadMaterializeRoutes,
  ...zeroIntegrationsTeamsDownloadFileRoutes,
  ...zeroIntegrationsTeamsMessageRoutes,
  ...zeroIntegrationsTeamsUploadCompleteRoutes,
  ...integrationsTeamsUploadInitRoutes,
  ...zeroSlackChannelsRoutes,
  ...steamPlayerRoutes,
  ...zeroIntegrationsTelegramRoutes,
  ...zeroIntegrationsTelegramMessageRoutes,
  ...zeroIntegrationsTelegramUploadCompleteRoutes,
  ...integrationsTelegramUploadInitRoutes,
  ...zeroTeamRoutes,
  ...zeroUploadsCompleteRoutes,
  ...zeroUploadsMultipartRoutes,
  ...zeroUploadsPrepareRoutes,
  ...registryResourceDownloadRoutes,
  ...zeroUsageMembersRoutes,
  ...zeroUsageRecordRoutes,
  ...modelStatsRoutes,
  ...presentationImagesRoutes,
  ...runnersRoutes,
];
