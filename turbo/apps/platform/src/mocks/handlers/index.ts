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
import { apiScopeHandlers } from "./api-scope.ts";
import { apiSecretsHandlers, resetMockSecrets } from "./api-secrets.ts";
import { apiVariablesHandlers, resetMockVariables } from "./api-variables.ts";
import { exampleHandlers } from "./example.ts";
import { platformLogsHandlers } from "./v1-runs.ts";

export const handlers = [
  ...apiModelProvidersHandlers,
  ...apiScopeHandlers,
  ...apiSecretsHandlers,
  ...apiVariablesHandlers,
  ...exampleHandlers,
  ...platformLogsHandlers,
];

export function resetAllMockHandlers(): void {
  resetMockModelProviders();
  resetMockSecrets();
  resetMockVariables();
}
