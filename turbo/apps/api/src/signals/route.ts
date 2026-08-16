import { authMeRoutes } from "./routes/auth-me";
import { cliAuthRoutes } from "./routes/cli-auth";
import type { RouteEntry } from "./route-entry";
import { connectorsSlugCallbackRoutes } from "./routes/connectors-slug-callback";
import { cronCompactChatThreadSnapshotsRoutes } from "./routes/cron-compact-chat-thread-snapshots";
import { cronProjectChatEventSearchRoutes } from "./routes/cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "./routes/cron-snapshot-chat-events";
import { cronRetainChatEventsRoutes } from "./routes/cron-retain-chat-events";
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
import { agentInstructionsRoutes } from "./routes/agent-instructions";
import { agentsRoutes } from "./routes/agents";
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
import { chatThreadRoutes } from "./routes/chat-threads";
import { chatEventsRoutes } from "./routes/chat-events";
import { sharedThreadRoutes } from "./routes/shared-threads";
import { claudeCodeDeviceAuthRoutes } from "./routes/claude-code-device-auth";
import { zeroComposesRoutes } from "./routes/zero-composes";
import { computerUseAuthorizationRoutes } from "./routes/computer-use-authorization";
import { computerUseRoutes } from "./routes/computer-use";
import { codexDeviceAuthRoutes } from "./routes/codex-device-auth";
import { connectorCatalogRoutes } from "./routes/connector-catalog";
import { connectorCheckRoutes } from "./routes/connector-check";
import { connectorsExternalCodeRoutes } from "./routes/connectors-external-code";
import { connectorsOauthDeviceAuthRoutes } from "./routes/connectors-oauth-device-auth";
import { connectorsRoutes } from "./routes/connectors";
import { customConnectorsRoutes } from "./routes/custom-connectors";
import { zeroEmailInboundRoutes } from "./routes/zero-email-inbound";
import { zeroFeatureSwitchesRoutes } from "./routes/zero-feature-switches";
import { financeRoutes } from "./routes/finance";
import { seoRoutes } from "./routes/seo";
import { zeroGoalsRoutes } from "./routes/zero-goals";
import { hostRoutes } from "./routes/host";
import { builtInGenerationRoutes } from "./routes/built-in-generation";
import { imageIoGenerateRoutes } from "./routes/image-io-generate";
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
import { orgDeleteRoutes } from "./routes/org-delete";
import { orgLogoRoutes } from "./routes/org-logo";
import { orgMembersRoutes } from "./routes/org-members";
import { orgMembershipRequestsRoutes } from "./routes/org-membership-requests";
import { orgReadRoutes } from "./routes/org-read";
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
import { browserRoutes } from "./routes/browser";
import { browserAuthorizationRoutes } from "./routes/browser-authorization";
import { workflowsRoutes } from "./routes/workflows";
import { workflowAutomationsRoutes } from "./routes/workflow-automations";
import { strapiIntegrationsRoutes } from "./routes/strapi-integrations";
import { strapiEventsRoutes } from "./routes/strapi-events";
import { integrationsGithubRoutes } from "./routes/integrations-github";
import { integrationsAgentPhoneRoutes } from "./routes/integrations-agentphone";
import { integrationsPhoneDownloadFileRoutes } from "./routes/integrations-phone-download-file";
import { integrationsPhoneMessageRoutes } from "./routes/integrations-phone-message";
import { integrationsPhoneUploadCompleteRoutes } from "./routes/integrations-phone-upload-complete";
import { integrationsPhoneUploadInitRoutes } from "./routes/integrations-phone-upload-init";
import { integrationsGithubDownloadFileRoutes } from "./routes/integrations-github-download-file";
import { integrationsGithubUploadCompleteRoutes } from "./routes/integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "./routes/integrations-github-upload-init";
import { integrationsFeishuFileRoutes } from "./routes/integrations-feishu-files";
import { integrationsSlackRoutes } from "./routes/integrations-slack";
import { integrationsSlackMessageRoutes } from "./routes/integrations-slack-message";
import { integrationsFeishuMessageRoutes } from "./routes/integrations-feishu-message";
import { integrationsSlackUploadCompleteRoutes } from "./routes/integrations-slack-upload-complete";
import { integrationsSlackUploadInitRoutes } from "./routes/integrations-slack-upload-init";
import { integrationsSlackUploadMaterializeRoutes } from "./routes/integrations-slack-upload-materialize";
import { integrationsTeamsDownloadFileRoutes } from "./routes/integrations-teams-download-file";
import { integrationsTeamsMessageRoutes } from "./routes/integrations-teams-message";
import { integrationsTeamsUploadCompleteRoutes } from "./routes/integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "./routes/integrations-teams-upload-init";
import { integrationsTelegramRoutes } from "./routes/integrations-telegram";
import { integrationsTelegramMessageRoutes } from "./routes/integrations-telegram-message";
import { integrationsTelegramUploadCompleteRoutes } from "./routes/integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "./routes/integrations-telegram-upload-init";
import { slackChannelsRoutes } from "./routes/slack-channels";
import { slackCommandsRoutes } from "./routes/slack-commands";
import { slackConnectRoutes } from "./routes/slack-connect";
import { slackEventsRoutes } from "./routes/slack-events";
import { slackInteractiveRoutes } from "./routes/slack-interactive";
import { slackOauthRoutes } from "./routes/slack-oauth";
import { feishuBrowserConnectRoutes } from "./routes/feishu-browser-connect";
import { feishuConnectRoutes } from "./routes/feishu-connect";
import { feishuEventsRoutes } from "./routes/feishu-events";
import { feishuOauthRoutes } from "./routes/feishu-oauth";
import { steamPlayerRoutes } from "./routes/steam-player";
import { teamsBrowserConnectRoutes } from "./routes/teams-browser-connect";
import { teamsBotRoutes } from "./routes/teams-bot";
import { teamsConnectRoutes } from "./routes/teams-connect";
import { teamsOauthRoutes } from "./routes/teams-oauth";
import { teamRoutes } from "./routes/team";
import { uploadsCompleteRoutes } from "./routes/uploads-complete";
import { uploadsMultipartRoutes } from "./routes/uploads-multipart";
import { uploadsPrepareRoutes } from "./routes/uploads-prepare";
import { usageMembersRoutes } from "./routes/usage-members";
import { usageRecordRoutes } from "./routes/usage-record";
import { userPreferencesRoutes } from "./routes/user-preferences";
import { userPermissionGrantsRoutes } from "./routes/user-permission-grants";
import { userModelPreferenceRoutes } from "./routes/user-model-preference";
import { avatarVideoRoutes } from "./routes/avatar-video";
import { voiceIoQuotaRoutes } from "./routes/voice-io-quota";
import { voiceIoSpeechRoutes } from "./routes/voice-io-speech";
import { voiceIoSttRoutes } from "./routes/voice-io-stt";
import { videoIoGenerateRoutes } from "./routes/video-io-generate";
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
  ...cronRetainChatEventsRoutes,
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
  ...agentInstructionsRoutes,
  ...agentsRoutes,
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
  ...chatThreadRoutes,
  ...chatEventsRoutes,
  ...sharedThreadRoutes,
  ...claudeCodeDeviceAuthRoutes,
  ...zeroComposesRoutes,
  ...computerUseAuthorizationRoutes,
  ...computerUseRoutes,
  ...codexDeviceAuthRoutes,
  ...connectorCatalogRoutes,
  ...connectorCheckRoutes,
  ...connectorsExternalCodeRoutes,
  ...connectorsOauthDeviceAuthRoutes,
  ...connectorsRoutes,
  ...customConnectorsRoutes,
  ...zeroEmailInboundRoutes,
  ...zeroFeatureSwitchesRoutes,
  ...financeRoutes,
  ...seoRoutes,
  ...zeroGoalsRoutes,
  ...hostRoutes,
  ...builtInGenerationRoutes,
  ...imageIoGenerateRoutes,
  ...imageShareXRoutes,
  ...avatarVideoRoutes,
  ...videoIoGenerateRoutes,
  ...logsRoutes,
  ...zeroMailRoutes,
  ...mapsRoutes,
  ...mcpConnectorsRoutes,
  ...weatherRoutes,
  ...scrapeRoutes,
  ...peopleSearchRoutes,
  ...webSearchRoutes,
  ...browserRoutes,
  ...browserAuthorizationRoutes,
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
  ...orgDeleteRoutes,
  ...orgLogoRoutes,
  ...orgMembersRoutes,
  ...orgMembershipRequestsRoutes,
  ...orgReadRoutes,
  ...pushSubscriptionsRoutes,
  ...userPermissionGrantsRoutes,
  ...userPreferencesRoutes,
  ...userModelPreferenceRoutes,
  ...workflowsRoutes,
  ...workflowAutomationsRoutes,
  ...strapiIntegrationsRoutes,
  ...integrationsGithubRoutes,
  ...slackConnectRoutes,
  ...slackOauthRoutes,
  ...slackCommandsRoutes,
  ...slackEventsRoutes,
  ...slackInteractiveRoutes,
  ...feishuBrowserConnectRoutes,
  ...feishuConnectRoutes,
  ...feishuEventsRoutes,
  ...feishuOauthRoutes,
  ...teamsBrowserConnectRoutes,
  ...teamsBotRoutes,
  ...teamsConnectRoutes,
  ...teamsOauthRoutes,
  ...integrationsAgentPhoneRoutes,
  ...integrationsPhoneDownloadFileRoutes,
  ...integrationsPhoneMessageRoutes,
  ...integrationsPhoneUploadCompleteRoutes,
  ...integrationsPhoneUploadInitRoutes,
  ...integrationsGithubDownloadFileRoutes,
  ...integrationsGithubUploadCompleteRoutes,
  ...integrationsGithubUploadInitRoutes,
  ...integrationsFeishuFileRoutes,
  ...integrationsSlackRoutes,
  ...integrationsSlackMessageRoutes,
  ...integrationsFeishuMessageRoutes,
  ...integrationsSlackUploadCompleteRoutes,
  ...integrationsSlackUploadInitRoutes,
  ...integrationsSlackUploadMaterializeRoutes,
  ...integrationsTeamsDownloadFileRoutes,
  ...integrationsTeamsMessageRoutes,
  ...integrationsTeamsUploadCompleteRoutes,
  ...integrationsTeamsUploadInitRoutes,
  ...slackChannelsRoutes,
  ...steamPlayerRoutes,
  ...integrationsTelegramRoutes,
  ...integrationsTelegramMessageRoutes,
  ...integrationsTelegramUploadCompleteRoutes,
  ...integrationsTelegramUploadInitRoutes,
  ...teamRoutes,
  ...uploadsCompleteRoutes,
  ...uploadsMultipartRoutes,
  ...uploadsPrepareRoutes,
  ...registryResourceDownloadRoutes,
  ...usageMembersRoutes,
  ...usageRecordRoutes,
  ...modelStatsRoutes,
  ...presentationImagesRoutes,
  ...runnersRoutes,
];
