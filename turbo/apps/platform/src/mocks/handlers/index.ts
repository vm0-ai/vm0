/**
 * MSW Request Handlers
 *
 * This file aggregates all API mock handlers.
 * Import handlers from individual files and combine them here.
 */

import {
  apiModelProvidersHandlers,
  resetMockModelProviders,
} from "./api-model-providers.ts";
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
import { appLogsHandlers } from "./v1-runs.ts";
import {
  apiIntegrationsSlackOrgHandlers,
  resetMockSlackOrgIntegration,
} from "./api-integrations-slack-org.ts";
import {
  apiIntegrationsTelegramHandlers,
  resetMockTelegramIntegration,
} from "./api-integrations-telegram.ts";
import { apiAgentsHandlers } from "./api-agents.ts";
import {
  apiUserPreferencesHandlers,
  resetMockUserPreferences,
} from "./api-user-preferences.ts";
import { apiOnboardingHandlers } from "./api-onboarding.ts";

export const handlers = [
  ...apiModelProvidersHandlers,
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
];

export function resetAllMockHandlers(): void {
  resetMockModelProviders();
  resetMockConnectors();
  resetMockSecrets();
  resetMockVariables();
  resetMockSlackOrgIntegration();
  resetMockTelegramIntegration();
  resetMockUserPreferences();
  resetMockOrgModelProviders();
}
