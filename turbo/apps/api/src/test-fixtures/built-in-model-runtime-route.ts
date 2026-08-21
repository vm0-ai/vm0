/**
 * Missing operator-managed keys are global infrastructure state and cannot be
 * isolated through a user-facing API. This fixture scopes that state to one
 * async request chain so route tests never delete or restore shared key rows.
 */
import { withBuiltInModelRuntimeRouteUnavailableForTest as withRuntimeRouteUnavailable } from "../signals/services/built-in-model-runtime-route.service";

export function withBuiltInModelRuntimeRouteUnavailableForTest<T>(
  selectedModel: string,
  work: () => Promise<T>,
): Promise<T> {
  return withRuntimeRouteUnavailable(selectedModel, work);
}
