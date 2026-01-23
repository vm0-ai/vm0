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
import { exampleHandlers } from "./example.ts";
import { v1RunsHandlers } from "./v1-runs.ts";

export const handlers = [
  ...apiModelProvidersHandlers,
  ...apiScopeHandlers,
  ...exampleHandlers,
  ...v1RunsHandlers,
];

export function resetAllMockHandlers(): void {
  resetMockModelProviders();
}
