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
import { apiOrgHandlers } from "./api-org.ts";
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
import { apiAgentsHandlers, resetMockComposesList } from "./api-agents.ts";
import {
  apiFeatureSwitchesHandlers,
  resetMockFeatureSwitches,
} from "./api-feature-switches.ts";
import { apiRealtimeHandlers } from "./api-realtime.ts";
import { resetAblySubscriptions } from "../ably.ts";
import {
  apiUserPreferencesHandlers,
  resetMockUserPreferences,
} from "./api-user-preferences.ts";
import { apiOnboardingHandlers } from "./api-onboarding.ts";
import { apiBillingHandlers, resetMockBilling } from "./api-billing.ts";
import {
  apiIntegrationsSlackConnectHandlers,
  resetMockSlackConnect,
} from "./api-integrations-slack-connect.ts";
import {
  apiPermissionAccessRequestsHandlers,
  resetMockPermissionRequests,
} from "./api-permission-access-requests.ts";
import { apiPermissionPoliciesHandlers } from "./api-permission-policies.ts";

export const handlers = [
  ...apiConnectorsHandlers,
  ...apiOrgHandlers,
  ...apiOrgModelProvidersHandlers,
  ...apiSecretsHandlers,
  ...apiVariablesHandlers,
  ...exampleHandlers,
  ...appLogsHandlers,
  ...apiIntegrationsSlackOrgHandlers,
  ...apiIntegrationsTelegramHandlers,
  ...apiAgentsHandlers,
  ...apiUserPreferencesHandlers,
  ...apiOnboardingHandlers,
  ...apiBillingHandlers,
  ...apiIntegrationsSlackConnectHandlers,
  ...apiFeatureSwitchesHandlers,
  ...apiRealtimeHandlers,
  ...apiPermissionAccessRequestsHandlers,
  ...apiPermissionPoliciesHandlers,
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
  resetMockFeatureSwitches();
  resetAblySubscriptions();
  resetMockPermissionRequests();
  resetMockComposesList();
}
