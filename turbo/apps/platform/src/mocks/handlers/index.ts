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
import { apiUsageHandlers, resetMockUsageMembers } from "./api-usage.ts";
import {
  apiUsageInsightHandlers,
  resetMockUsageInsight,
} from "./api-usage-insight.ts";
import {
  apiOrgModelProvidersHandlers,
  resetMockOrgModelProviders,
} from "./api-org-model-providers.ts";
import {
  apiOrgModelPoliciesHandlers,
  resetMockOrgModelPolicies,
} from "./api-org-model-policies.ts";
import {
  apiPersonalModelProvidersHandlers,
  resetMockPersonalModelProviders,
} from "./api-personal-model-providers.ts";
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
  apiIntegrationsAgentPhoneHandlers,
  resetMockAgentPhoneIntegration,
} from "./api-integrations-agentphone.ts";
import {
  apiIntegrationsGithubHandlers,
  resetMockGithubIntegration,
} from "./api-integrations-github.ts";
import {
  apiAgentsHandlers,
  resetMockComposesList,
  resetMockTeam,
} from "./api-agents.ts";
import { apiSkillsHandlers, resetMockSkills } from "./api-skills.ts";
import { apiMemoryHandlers, resetMockMemory } from "./api-memory.ts";
import {
  apiMemoryActivityHandlers,
  resetMockMemoryActivity,
} from "./api-memory-activity.ts";
import { apiRunsHandlers } from "./api-runs.ts";
import { apiFeatureSwitchesHandlers } from "./api-feature-switches.ts";
import { apiRealtimeHandlers } from "./api-realtime.ts";
import { resetAblySubscriptions } from "../ably.ts";
import {
  apiUserPreferencesHandlers,
  resetMockUserPreferences,
} from "./api-user-preferences.ts";
import {
  apiUserModelPreferenceHandlers,
  resetMockUserModelPreference,
} from "./api-user-model-preference.ts";
import {
  apiOnboardingHandlers,
  resetMockOnboardingStatus,
} from "./api-onboarding.ts";
import { apiBillingHandlers, resetMockBilling } from "./api-billing.ts";
import { apiAttributionHandlers } from "./api-attribution.ts";
import { apiSchedulesHandlers, resetMockSchedules } from "./api-schedules.ts";
import { apiInsightsHandlers } from "./api-insights.ts";
import { apiQueuePositionHandlers } from "./api-queue-position.ts";
import {
  apiIntegrationsSlackConnectHandlers,
  resetMockSlackConnect,
} from "./api-integrations-slack-connect.ts";
import {
  apiUserPermissionGrantsHandlers,
  resetMockUserPermissionGrants,
} from "./api-user-permission-grants.ts";
import { apiVoiceIoHandlers } from "./api-voice-io.ts";

export const handlers = [
  ...apiConnectorsHandlers,
  ...apiOrgHandlers,
  ...apiOrgMembersHandlers,
  ...apiUsageHandlers,
  ...apiUsageInsightHandlers,
  ...apiOrgModelProvidersHandlers,
  ...apiOrgModelPoliciesHandlers,
  ...apiPersonalModelProvidersHandlers,
  ...apiSecretsHandlers,
  ...apiVariablesHandlers,
  ...exampleHandlers,
  ...appLogsHandlers,
  ...apiIntegrationsSlackOrgHandlers,
  ...apiIntegrationsTelegramHandlers,
  ...apiIntegrationsAgentPhoneHandlers,
  ...apiIntegrationsGithubHandlers,
  ...apiAgentsHandlers,
  ...apiSkillsHandlers,
  ...apiMemoryHandlers,
  ...apiMemoryActivityHandlers,
  ...apiRunsHandlers,
  ...apiUserPreferencesHandlers,
  ...apiUserModelPreferenceHandlers,
  ...apiOnboardingHandlers,
  ...apiBillingHandlers,
  ...apiAttributionHandlers,
  ...apiIntegrationsSlackConnectHandlers,
  ...apiFeatureSwitchesHandlers,
  ...apiRealtimeHandlers,
  ...apiUserPermissionGrantsHandlers,
  ...apiSchedulesHandlers,
  ...apiInsightsHandlers,
  ...apiQueuePositionHandlers,
  ...apiVoiceIoHandlers,
];

export function resetAllMockHandlers(): void {
  resetMockConnectors();
  resetMockSecrets();
  resetMockVariables();
  resetMockSlackOrgIntegration();
  resetMockTelegramIntegration();
  resetMockAgentPhoneIntegration();
  resetMockGithubIntegration();
  resetMockUserPreferences();
  resetMockUserModelPreference();
  resetMockOrgModelProviders();
  resetMockOrgModelPolicies();
  resetMockPersonalModelProviders();
  resetMockBilling();
  resetMockSlackConnect();
  resetAblySubscriptions();
  resetMockUserPermissionGrants();
  resetMockComposesList();
  resetMockOrg();
  resetMockOrgLogo();
  resetMockOrgMembers();
  resetMockUsageMembers();
  resetMockUsageInsight();
  resetMockSchedules();
  resetMockTeam();
  resetMockSkills();
  resetMockMemory();
  resetMockMemoryActivity();
  resetMockOnboardingStatus();
}
