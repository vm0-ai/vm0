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
import { apiScopeHandlers } from "./api-scope.ts";
import { apiSecretsHandlers, resetMockSecrets } from "./api-secrets.ts";
import { apiVariablesHandlers, resetMockVariables } from "./api-variables.ts";
import { exampleHandlers } from "./example.ts";
import { platformLogsHandlers } from "./v1-runs.ts";
import {
  apiIntegrationsSlackHandlers,
  resetMockSlackIntegration,
} from "./api-integrations-slack.ts";
import { apiAgentsHandlers } from "./api-agents.ts";

export const handlers = [
  ...apiModelProvidersHandlers,
  ...apiConnectorsHandlers,
  ...apiScopeHandlers,
  ...apiSecretsHandlers,
  ...apiVariablesHandlers,
  ...exampleHandlers,
  ...platformLogsHandlers,
  ...apiIntegrationsSlackHandlers,
  ...apiAgentsHandlers,
];

export function resetAllMockHandlers(): void {
  resetMockModelProviders();
  resetMockConnectors();
  resetMockSecrets();
  resetMockVariables();
  resetMockSlackIntegration();
}
