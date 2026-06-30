import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { zeroConnectorsByTypeContract } from "@vm0/api-contracts/contracts/zero-connectors";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import type { RouteEntry } from "../../../route-entry";
import { zeroConnectorsRoutes } from "../../zero-connectors";
import { zeroFeatureSwitchesRoutes } from "../../zero-feature-switches";
import { zeroMeModelProvidersDeleteRoutes } from "../../zero-me-model-providers-delete";
import { zeroMeModelProvidersListRoutes } from "../../zero-me-model-providers-list";
import { zeroModelProvidersRoutes } from "../../zero-model-providers";
import { zeroUserPreferencesRoutes } from "../../zero-user-preferences";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

const authDeviceSupportRoutes: readonly RouteEntry[] = [
  ...zeroConnectorsRoutes,
  ...zeroFeatureSwitchesRoutes,
  ...zeroMeModelProvidersDeleteRoutes,
  ...zeroMeModelProvidersListRoutes,
  ...zeroModelProvidersRoutes,
  ...zeroUserPreferencesRoutes,
];

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function authenticate(
  context: TestContext,
  actor: ApiTestUser | null,
): AuthHeaders {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return authHeaders(actor);
}

function authDeviceSupportApp(context: TestContext) {
  return setupAppWithRoutes({
    context,
    routes: authDeviceSupportRoutes,
  });
}

export function createAuthDeviceSupportApi(context: TestContext) {
  return {
    async readPreferences(actor: ApiTestUser) {
      return await accept(
        authDeviceSupportApp(context)(zeroUserPreferencesContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async listModelProviders(actor: ApiTestUser) {
      return await accept(
        authDeviceSupportApp(context)(zeroModelProvidersMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async listPersonalModelProviders(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404 | 500)[],
    ) {
      return await accept(
        authDeviceSupportApp(context)(
          zeroPersonalModelProvidersMainContract,
        ).list({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async deletePersonalModelProvider(
      actor: ApiTestUser | null,
      type: "claude-code-oauth-token" | "codex-oauth-token",
      statuses: readonly (204 | 401 | 404 | 500)[],
    ) {
      return await accept(
        authDeviceSupportApp(context)(
          zeroPersonalModelProvidersByTypeContract,
        ).delete({
          headers: authenticate(context, actor),
          params: { type },
        }),
        statuses,
      );
    },

    async updateFeatureSwitches(
      actor: ApiTestUser,
      switches: Readonly<Record<string, boolean>>,
    ): Promise<Readonly<Record<string, boolean>>> {
      const response = await accept(
        authDeviceSupportApp(context)(zeroFeatureSwitchesContract).update({
          headers: authenticate(context, actor),
          body: { switches },
        }),
        [200],
      );
      return response.body.switches;
    },

    async readConnectorByType(
      actor: ApiTestUser,
      type: ConnectorType,
    ): Promise<ConnectorResponse> {
      const response = await accept(
        authDeviceSupportApp(context)(zeroConnectorsByTypeContract).get({
          params: { type },
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },
  };
}
