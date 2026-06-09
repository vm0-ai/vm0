import type {
  ConnectorListResponse,
  ConnectorOauthDeviceAuthSessionPollResponse,
  ConnectorOauthDeviceAuthSessionStartResponse,
  ConnectorOauthStartResponse,
  ConnectorResponse,
  ScopeDiffResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import { connectorsTypeCallbackContract } from "@vm0/api-contracts/contracts/connectors-type-callback";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
  type PatchCustomConnectorBody,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorExternalCodeSessionContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorOauthStartContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
  zeroConnectorsSearchContract,
  type ConnectorSearchResponse,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type {
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { http, HttpResponse } from "msw";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

type CallbackQuery = {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly error_description?: string;
};

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const TEST_OAUTH_DEVICE_CODE_URL =
  "http://localhost:3000/api/test/oauth-provider/device/code";
const TEST_OAUTH_TOKEN_URL =
  "http://localhost:3000/api/test/oauth-provider/token";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function expectStatus<
  TResponse extends { readonly status: number },
  TStatus extends TResponse["status"],
>(
  response: TResponse,
  status: TStatus,
): asserts response is Extract<TResponse, { readonly status: TStatus }> {
  if (response.status !== status) {
    throw new Error(`Expected status ${status}, got ${response.status}`);
  }
}

export function mockGitHubConnectorOAuth(): void {
  mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", "github-client-id");
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "github-client-secret");

  server.use(
    http.post(GITHUB_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      const code = body.get("code") ?? "missing-code";
      return HttpResponse.json({
        access_token: `github-access-${code}`,
        scope: "repo,project,workflow",
      });
    }),
    http.get(GITHUB_USER_URL, () => {
      return HttpResponse.json({
        id: 42,
        login: "bdd-github-user",
        email: "bdd-github@example.test",
      });
    }),
  );
}

export function mockTestOAuthDeviceConnectorProvider(): void {
  server.use(
    http.post(TEST_OAUTH_DEVICE_CODE_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      const clientId = body.get("client_id") ?? "missing-client";
      const scope = body.get("scope") ?? "";
      const mode = body.get("mode");
      const modeSuffix = mode ? `:${mode}` : "";
      const deviceCode = `test-device:${clientId}:${scope}${modeSuffix}`;

      return HttpResponse.json({
        device_code: deviceCode,
        user_code: "TEST-DEVICE",
        verification_uri: "https://oauth-device.test/device",
        verification_uri_complete:
          "https://oauth-device.test/device?user_code=TEST-DEVICE",
        expires_in: 600,
        interval: 0,
      });
    }),
    http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      const deviceCode = body.get("device_code");

      if (body.get("grant_type") !== DEVICE_CODE_GRANT_TYPE) {
        return HttpResponse.json(
          { error: "unsupported_grant_type" },
          { status: 400 },
        );
      }
      if (!deviceCode?.startsWith("test-device:")) {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "unknown device code" },
          { status: 400 },
        );
      }

      return HttpResponse.json({
        access_token: `test-device-access:${deviceCode}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      });
    }),
  );
}

export function createConnectorBddApi(context: TestContext) {
  const mocks = createZeroRouteMocks(context);

  function authenticate(nextActor: ApiTestUser | null): AuthHeaders {
    if (!nextActor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    mocks.clerk.session(nextActor.userId, nextActor.orgId, nextActor.orgRole);
    return authHeaders(nextActor);
  }

  const api = {
    async requestListConnectors(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroConnectorsMainContract);
      return await accept(
        client.list({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async listConnectors(actor: ApiTestUser): Promise<ConnectorListResponse> {
      const response = await api.requestListConnectors(actor, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async requestSearchConnectors(
      actor: ApiTestUser | null,
      keyword: string | undefined,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(zeroConnectorsSearchContract);
      return await accept(
        client.search({ query: { keyword }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async searchConnectors(
      actor: ApiTestUser,
      keyword?: string,
    ): Promise<ConnectorSearchResponse> {
      const response = await api.requestSearchConnectors(actor, keyword, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async requestReadConnectorByType(
      actor: ApiTestUser | null,
      type: ConnectorType,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroConnectorsByTypeContract);
      return await accept(
        client.get({ params: { type }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async readConnectorByType(
      actor: ApiTestUser,
      type: ConnectorType,
    ): Promise<ConnectorResponse> {
      const response = await api.requestReadConnectorByType(actor, type, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async deleteConnectorByType(
      actor: ApiTestUser,
      type: ConnectorType,
      statuses: readonly (204 | 401 | 404)[] = [204],
    ): Promise<void> {
      const client = setupApp({ context })(zeroConnectorsByTypeContract);
      await accept(
        client.delete({ params: { type }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async requestScopeDiff(
      actor: ApiTestUser | null,
      type: ConnectorType,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroConnectorScopeDiffContract);
      return await accept(
        client.getScopeDiff({
          params: { type },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async readScopeDiff(
      actor: ApiTestUser,
      type: ConnectorType,
    ): Promise<ScopeDiffResponse> {
      const response = await api.requestScopeDiff(actor, type, [200]);
      expectStatus(response, 200);
      return response.body;
    },

    async requestManualGrant(
      actor: ApiTestUser | null,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      values: Readonly<Record<string, string>>,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(zeroConnectorManualGrantContract);
      return await accept(
        client.connect({
          params: { type },
          headers: authenticate(actor),
          body: { authMethod, values },
        }),
        statuses,
      );
    },

    async connectManualGrant(
      actor: ApiTestUser,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      values: Readonly<Record<string, string>>,
    ): Promise<ConnectorResponse> {
      const response = await api.requestManualGrant(
        actor,
        type,
        authMethod,
        values,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestOauthStart(
      actor: ApiTestUser | null,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroConnectorOauthStartContract);
      return await accept(
        client.start({
          params: { type },
          headers: authenticate(actor),
          body: { authMethod },
        }),
        statuses,
      );
    },

    async startOauth(
      actor: ApiTestUser,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
    ): Promise<ConnectorOauthStartResponse> {
      const response = await api.requestOauthStart(
        actor,
        type,
        authMethod,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async completeOauthCallback(type: string, query: CallbackQuery) {
      const client = setupApp({ context })(connectorsTypeCallbackContract);
      return await accept(
        client.callback({ params: { type }, query, headers: {} }),
        [307],
      );
    },

    async requestDeviceAuthStart(
      actor: ApiTestUser | null,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      options: Readonly<Record<string, string>> | undefined,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(
        zeroConnectorOauthDeviceAuthSessionContract,
      );
      return await accept(
        client.create({
          params: { type },
          headers: authenticate(actor),
          body: { authMethod, options },
        }),
        statuses,
      );
    },

    async startDeviceAuth(
      actor: ApiTestUser,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      options?: Readonly<Record<string, string>>,
    ): Promise<ConnectorOauthDeviceAuthSessionStartResponse> {
      const response = await api.requestDeviceAuthStart(
        actor,
        type,
        authMethod,
        options,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestDeviceAuthPoll(
      actor: ApiTestUser | null,
      type: ConnectorType,
      sessionId: string,
      sessionToken: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(
        zeroConnectorOauthDeviceAuthSessionContract,
      );
      return await accept(
        client.poll({
          params: { type, sessionId },
          headers: authenticate(actor),
          body: { sessionToken },
        }),
        statuses,
      );
    },

    async pollDeviceAuth(
      actor: ApiTestUser,
      type: ConnectorType,
      sessionId: string,
      sessionToken: string,
    ): Promise<ConnectorOauthDeviceAuthSessionPollResponse> {
      const response = await api.requestDeviceAuthPoll(
        actor,
        type,
        sessionId,
        sessionToken,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async requestExternalCodeStart(
      actor: ApiTestUser | null,
      type: ConnectorType,
      authMethod: ConnectorAuthMethodId,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(
        zeroConnectorExternalCodeSessionContract,
      );
      return await accept(
        client.create({
          params: { type },
          headers: authenticate(actor),
          body: { authMethod },
        }),
        statuses,
      );
    },

    async requestExternalCodeComplete(
      actor: ApiTestUser | null,
      type: ConnectorType,
      args: {
        readonly sessionId: string;
        readonly sessionToken: string;
        readonly code: string;
      },
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(
        zeroConnectorExternalCodeSessionContract,
      );
      return await accept(
        client.complete({
          params: { type, sessionId: args.sessionId },
          headers: authenticate(actor),
          body: { sessionToken: args.sessionToken, code: args.code },
        }),
        statuses,
      );
    },

    async updateFeatureSwitches(
      actor: ApiTestUser,
      switches: Readonly<Record<string, boolean>>,
    ): Promise<Readonly<Record<string, boolean>>> {
      const client = setupApp({ context })(zeroFeatureSwitchesContract);
      const response = await accept(
        client.update({
          headers: authenticate(actor),
          body: { switches },
        }),
        [200],
      );
      return response.body.switches;
    },

    async deleteFeatureSwitches(actor: ApiTestUser): Promise<void> {
      const client = setupApp({ context })(zeroFeatureSwitchesContract);
      await accept(client.delete({ headers: authenticate(actor) }), [200]);
    },

    async requestCreateCustomConnector(
      actor: ApiTestUser | null,
      body: CreateCustomConnectorBody,
      statuses: readonly (201 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroCustomConnectorsContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async createCustomConnector(
      actor: ApiTestUser,
      body: CreateCustomConnectorBody,
    ): Promise<CustomConnectorResponse> {
      const response = await api.requestCreateCustomConnector(
        actor,
        body,
        [201],
      );
      expectStatus(response, 201);
      return response.body;
    },

    async listCustomConnectors(
      actor: ApiTestUser,
    ): Promise<readonly CustomConnectorResponse[]> {
      const client = setupApp({ context })(zeroCustomConnectorsContract);
      const response = await accept(
        client.list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body.connectors;
    },

    async requestPatchCustomConnector(
      actor: ApiTestUser | null,
      connectorId: string,
      body: PatchCustomConnectorBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(zeroCustomConnectorByIdContract);
      return await accept(
        client.patch({
          params: { id: connectorId },
          headers: authenticate(actor),
          body,
        }),
        statuses,
      );
    },

    async patchCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
      body: PatchCustomConnectorBody,
    ): Promise<CustomConnectorResponse> {
      const response = await api.requestPatchCustomConnector(
        actor,
        connectorId,
        body,
        [200],
      );
      expectStatus(response, 200);
      return response.body;
    },

    async deleteCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
      statuses: readonly (204 | 401 | 403 | 404 | 500)[] = [204],
    ): Promise<void> {
      const client = setupApp({ context })(zeroCustomConnectorByIdContract);
      await accept(
        client.delete({
          params: { id: connectorId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async setCustomConnectorSecret(
      actor: ApiTestUser,
      connectorId: string,
      value: string,
      statuses: readonly (204 | 400 | 401 | 404 | 500)[] = [204],
    ): Promise<void> {
      const client = setupApp({ context })(zeroCustomConnectorSecretContract);
      await accept(
        client.set({
          params: { id: connectorId },
          headers: authenticate(actor),
          body: { value },
        }),
        statuses,
      );
    },

    async deleteCustomConnectorSecret(
      actor: ApiTestUser,
      connectorId: string,
      statuses: readonly (204 | 401 | 404 | 500)[] = [204],
    ): Promise<void> {
      const client = setupApp({ context })(zeroCustomConnectorSecretContract);
      await accept(
        client.delete({
          params: { id: connectorId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async requestAgentCustomConnectors(
      actor: ApiTestUser | null,
      agentId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
      return await accept(
        client.get({ params: { id: agentId }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async readAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly string[]> {
      const response = await api.requestAgentCustomConnectors(
        actor,
        agentId,
        [200],
      );
      expectStatus(response, 200);
      return response.body.enabledIds;
    },

    async requestUpdateAgentCustomConnectors(
      actor: ApiTestUser | null,
      agentId: string,
      enabledIds: readonly string[],
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
      return await accept(
        client.update({
          params: { id: agentId },
          headers: authenticate(actor),
          body: { enabledIds: [...enabledIds] },
        }),
        statuses,
      );
    },

    async updateAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
      enabledIds: readonly string[],
    ): Promise<readonly string[]> {
      const response = await api.requestUpdateAgentCustomConnectors(
        actor,
        agentId,
        enabledIds,
        [200],
      );
      expectStatus(response, 200);
      return response.body.enabledIds;
    },
  };

  return api;
}
