import { computed, type Computed } from "ccstate";
import {
  getAvailableConnectorAuthMethodIds,
  isConnectorAuthMethodAvailable,
  type AvailableConnectorAuthMethodsOptions,
} from "@vm0/connectors/connector-utils";
import type {
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { getAllFeatureStates } from "@vm0/core/feature-switch";

import { userFeatureSwitchOverrides } from "./feature-switches.service";

const USER_CONNECTOR_AUTH_METHOD_OPTIONS = {
  apiAuthMethodPolicy: "include",
} as const satisfies AvailableConnectorAuthMethodsOptions;

/**
 * Feature-aware user availability for new connector actions.
 *
 * This is intentionally separate from runtime availability: disabling a
 * feature switch should block new connect/authorize/write entry points, while
 * existing runtime connector use remains a separate product policy.
 */
interface UserConnectorAvailability {
  readonly isAuthMethodAvailable: (
    type: ConnectorType,
    authMethod: ConnectorAuthMethodId,
  ) => boolean;
  readonly isConnectorTypeAvailable: (
    type: ConnectorType,
    options?: AvailableConnectorAuthMethodsOptions,
  ) => boolean;
}

function createUserConnectorAvailability(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly overrides: Record<string, boolean>;
}): UserConnectorAvailability {
  const featureStates = getAllFeatureStates(args);
  return {
    isAuthMethodAvailable(type, authMethod) {
      return isConnectorAuthMethodAvailable(type, authMethod, featureStates);
    },
    isConnectorTypeAvailable(
      type,
      options = USER_CONNECTOR_AUTH_METHOD_OPTIONS,
    ) {
      return (
        getAvailableConnectorAuthMethodIds(type, featureStates, options)
          .length > 0
      );
    },
  };
}

export function userConnectorAvailability(
  orgId: string,
  userId: string,
): Computed<Promise<UserConnectorAvailability>> {
  return computed(async (get): Promise<UserConnectorAvailability> => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return createUserConnectorAvailability({ orgId, userId, overrides });
  });
}

export function unavailableUserConnectorTypes(
  availability: UserConnectorAvailability,
  types: readonly ConnectorType[],
  options: AvailableConnectorAuthMethodsOptions = USER_CONNECTOR_AUTH_METHOD_OPTIONS,
): ConnectorType[] {
  return types.filter((type) => {
    return !availability.isConnectorTypeAvailable(type, options);
  });
}
