/**
 * MSW Request Handlers
 *
 * This file aggregates all API mock handlers.
 * Import handlers from individual files and combine them here.
 */

import {
  apiConnectorsHandlers,
  resetMockConnectors,
} from "./api-connectors.ts";
import { apiOrgHandlers, resetMockOrg, resetMockOrgLogo } from "./api-org.ts";
import {
  apiOrgMembersHandlers,
  resetMockOrgMembers,
} from "./api-org-members.ts";
import {
  apiOrgDomainsHandlers,
  resetMockOrgDomains,
} from "./api-org-domains.ts";
import {
  apiUsageHandlers,
  resetMockUsageMembers,
  resetMockMemberCreditCaps,
} from "./api-usage.ts";
import {
  apiUsageInsightHandlers,
  resetMockUsageInsight,
} from "./api-usage-insight.ts";
import {
  apiOrgModelProvidersHandlers,
  resetMockOrgModelProviders,
} from "./api-org-model-providers.ts";
import { apiSecretsHandlers, resetMockSecrets } from "./api-secrets.ts";
import { apiVariablesHandlers, resetMockVariables } from "./api-variables.ts";
import { exampleHandlers } from "./example.ts";
import { appLogsHandlers } from "./api-logs.ts";
import {
  apiIntegrationsSlackOrgHandlers,
  resetMockSlackOrgIntegration,
} from "./api-integrations-slack-org.ts";
import {
  apiIntegrationsTelegramHandlers,
  resetMockTelegramIntegration,
} from "./api-integrations-telegram.ts";
import {
  apiAgentsHandlers,
  resetMockComposesList,
  resetMockTeam,
} from "./api-agents.ts";
import { apiRunsHandlers } from "./api-runs.ts";
import { apiFeatureSwitchesHandlers } from "./api-feature-switches.ts";
import { apiRealtimeHandlers } from "./api-realtime.ts";
import { resetAblySubscriptions } from "../ably.ts";
import {
  apiUserPreferencesHandlers,
  resetMockUserPreferences,
} from "./api-user-preferences.ts";
import {
  apiOnboardingHandlers,
  resetMockOnboardingStatus,
} from "./api-onboarding.ts";
import { apiBillingHandlers, resetMockBilling } from "./api-billing.ts";
import { apiSchedulesHandlers, resetMockSchedules } from "./api-schedules.ts";
import { apiInsightsHandlers } from "./api-insights.ts";
import { apiQueuePositionHandlers } from "./api-queue-position.ts";
import {
  apiIntegrationsSlackConnectHandlers,
  resetMockSlackConnect,
} from "./api-integrations-slack-connect.ts";
import {
  apiPermissionAccessRequestsHandlers,
  resetMockPermissionRequests,
} from "./api-permission-access-requests.ts";
import { apiPermissionPoliciesHandlers } from "./api-permission-policies.ts";
import { apiVoiceChatHandlers, resetMockVoiceChat } from "./api-voice-chat.ts";
import { apiVoiceIoHandlers } from "./api-voice-io.ts";

export const handlers = [
  ...apiConnectorsHandlers,
  ...apiOrgHandlers,
  ...apiOrgMembersHandlers,
  ...apiOrgDomainsHandlers,
  ...apiUsageHandlers,
  ...apiUsageInsightHandlers,
  ...apiOrgModelProvidersHandlers,
  ...apiSecretsHandlers,
  ...apiVariablesHandlers,
  ...exampleHandlers,
  ...appLogsHandlers,
  ...apiIntegrationsSlackOrgHandlers,
  ...apiIntegrationsTelegramHandlers,
  ...apiAgentsHandlers,
  ...apiRunsHandlers,
  ...apiUserPreferencesHandlers,
  ...apiOnboardingHandlers,
  ...apiBillingHandlers,
  ...apiIntegrationsSlackConnectHandlers,
  ...apiFeatureSwitchesHandlers,
  ...apiRealtimeHandlers,
  ...apiPermissionAccessRequestsHandlers,
  ...apiPermissionPoliciesHandlers,
  ...apiSchedulesHandlers,
  ...apiInsightsHandlers,
  ...apiQueuePositionHandlers,
  ...apiVoiceChatHandlers,
  ...apiVoiceIoHandlers,
];

export function resetAllMockHandlers(): void {
  resetMockConnectors();
  resetMockSecrets();
  resetMockVariables();
  resetMockSlackOrgIntegration();
  resetMockTelegramIntegration();
  resetMockUserPreferences();
  resetMockOrgModelProviders();
  resetMockBilling();
  resetMockSlackConnect();
  resetAblySubscriptions();
  resetMockPermissionRequests();
  resetMockComposesList();
  resetMockOrg();
  resetMockOrgLogo();
  resetMockOrgMembers();
  resetMockOrgDomains();
  resetMockUsageMembers();
  resetMockMemberCreditCaps();
  resetMockUsageInsight();
  resetMockSchedules();
  resetMockTeam();
  resetMockOnboardingStatus();
  resetMockVoiceChat();
}
