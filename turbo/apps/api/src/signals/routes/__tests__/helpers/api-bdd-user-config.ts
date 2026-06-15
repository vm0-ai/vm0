import { randomUUID } from "node:crypto";

import { initContract } from "@ts-rest/core";
import { authContract } from "@vm0/api-contracts/contracts/auth";
import { apiKeysByIdContract } from "@vm0/api-contracts/contracts/api-keys";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { pushSubscriptionsContract } from "@vm0/api-contracts/contracts/push-subscriptions";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import type { SetVariableRequest } from "@vm0/api-contracts/contracts/variables";
import {
  zeroSecretsByNameContract,
  zeroVariablesByNameContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import {
  zeroUserModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import {
  zeroUserPreferencesContract,
  type UpdateUserPreferencesRequest,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import { z } from "zod";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { now } from "../../../../lib/time";
import {
  signPatJwtForTests,
  signSandboxJwtForTests,
} from "../../../auth/tokens";
import { healthAuthProbeContract } from "../../health-auth-probe";
import type { ApiTestUser } from "./api-bdd-auth-org";
import { createZeroRouteMocks } from "./zero-route-test";

type ClerkOrgRole = "org:admin" | "org:member";

interface AuthHeaders {
  readonly authorization?: string;
}

interface BearerCredential {
  readonly bearer: string;
}

/**
 * Session actor (Clerk mocks set on use) or a raw bearer token minted through
 * the API (PAT) or the test token signers (sandbox/zero). Precedent:
 * api-bdd-runs-automations' raw-bearer run creation.
 */
type Credential = ApiTestUser | BearerCredential;

interface MintedBearer {
  readonly token: string;
  readonly runId: string;
}

interface ProbeHeaders {
  readonly authorization?: string;
  readonly cookie?: string;
}

interface ProbeQuery {
  readonly acceptAnySandboxCapability?: string;
  readonly requiredCapability?: string;
}

interface RegisterPushBody {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

const c = initContract();

/**
 * Permissive mirror of the user-model-preference update route used to send
 * contract-invalid bodies through the app (the real contract types reject
 * them at compile time). Mirrors the raw `app.request` cases in the legacy
 * zero-user-model-preference test.
 */
const rawModelPreferenceContract = c.router({
  update: {
    method: "PUT" as const,
    path: "/api/zero/user-model-preference",
    headers: z.object({ authorization: z.string().optional() }),
    body: z.unknown(),
    responses: {
      200: z.unknown(),
      400: z.object({
        error: z.object({ message: z.string(), code: z.string() }),
      }),
      401: z.object({
        error: z.object({ message: z.string(), code: z.string() }),
      }),
    },
  },
});

function isBearerCredential(
  credential: Credential,
): credential is BearerCredential {
  return "bearer" in credential;
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Cannot use a no-org actor here");
  }
  return actor.orgId;
}

export function createUserConfigBddApi(context: TestContext) {
  const routeMocks = createZeroRouteMocks(context);

  function authenticate(credential: Credential | null): AuthHeaders {
    if (credential === null) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    if (isBearerCredential(credential)) {
      return { authorization: `Bearer ${credential.bearer}` };
    }
    routeMocks.clerk.session(
      credential.userId,
      credential.orgId,
      credential.orgRole,
    );
    return { authorization: "Bearer clerk-session" };
  }

  return {
    mockSession(actor: ApiTestUser | null): void {
      if (!actor) {
        context.mocks.clerk.authenticateRequest.mockResolvedValue({
          isAuthenticated: false,
        });
        return;
      }
      routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    },

    mockClerkUsers(actors: readonly ApiTestUser[]): void {
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: actors.map((actor) => {
          const emailId = `email_${actor.userId}`;
          return {
            id: actor.userId,
            emailAddresses: [{ id: emailId, emailAddress: actor.email }],
            primaryEmailAddressId: emailId,
            firstName: "BDD",
            lastName: "Actor",
          };
        }),
      });
    },

    mockMembership(actor: ApiTestUser, role: ClerkOrgRole | null): void {
      const orgId = requireOrgId(actor);
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: role === null ? [] : [{ role, organization: { id: orgId } }],
        },
      );
    },

    sandboxBearer(actor: ApiTestUser): MintedBearer {
      const seconds = Math.floor(now() / 1000);
      const runId = `run_${randomUUID()}`;
      const token = signSandboxJwtForTests({
        scope: "sandbox",
        userId: actor.userId,
        orgId: requireOrgId(actor),
        runId,
        iat: seconds,
        exp: seconds + 3600,
      });
      return { token, runId };
    },

    zeroBearer(
      actor: ApiTestUser,
      capabilities: readonly ZeroCapability[],
    ): MintedBearer {
      const seconds = Math.floor(now() / 1000);
      const runId = `run_${randomUUID()}`;
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId: actor.userId,
        orgId: requireOrgId(actor),
        runId,
        capabilities: [...capabilities],
        iat: seconds,
        exp: seconds + 3600,
      });
      return { token, runId };
    },

    forgedPatBearer(userId: string): string {
      const seconds = Math.floor(now() / 1000);
      return signPatJwtForTests({
        scope: "cli",
        userId,
        orgId: `org_${randomUUID()}`,
        tokenId: randomUUID(),
        iat: seconds,
        exp: seconds + 3600,
      });
    },

    async probeAuth(
      headers: ProbeHeaders,
      query: ProbeQuery,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(healthAuthProbeContract);
      return await accept(client.check({ headers, query }), statuses);
    },

    async readMe(credential: Credential): Promise<{
      readonly userId: string;
      readonly email: string;
    }> {
      const client = setupApp({ context })(authContract);
      const response = await accept(
        client.me({ headers: authenticate(credential) }),
        [200],
      );
      return response.body;
    },

    async readUserConnectors(
      credential: Credential,
      agentId: string,
    ): Promise<{ readonly enabledTypes: string[] }> {
      const client = setupApp({ context })(zeroUserConnectorsContract);
      const response = await accept(
        client.get({
          headers: authenticate(credential),
          params: { id: agentId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadUserConnectors(
      credential: Credential | null,
      agentId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroUserConnectorsContract);
      return await accept(
        client.get({
          headers: authenticate(credential),
          params: { id: agentId },
        }),
        statuses,
      );
    },

    async updateUserConnectors(
      credential: Credential,
      agentId: string,
      enabledTypes: readonly string[],
    ): Promise<{ readonly enabledTypes: string[] }> {
      const client = setupApp({ context })(zeroUserConnectorsContract);
      const response = await accept(
        client.update({
          headers: authenticate(credential),
          params: { id: agentId },
          body: { enabledTypes: [...enabledTypes] },
        }),
        [200],
      );
      return response.body;
    },

    async requestUpdateUserConnectors(
      credential: Credential | null,
      agentId: string,
      enabledTypes: readonly string[],
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroUserConnectorsContract);
      return await accept(
        client.update({
          headers: authenticate(credential),
          params: { id: agentId },
          body: { enabledTypes: [...enabledTypes] },
        }),
        statuses,
      );
    },

    async readModelPreference(
      actor: ApiTestUser,
    ): Promise<UserModelPreferenceResponse> {
      const client = setupApp({ context })(zeroUserModelPreferenceContract);
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestReadModelPreference(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroUserModelPreferenceContract);
      return await accept(
        client.get({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async updateModelPreference(
      actor: ApiTestUser,
      body: UpdateUserModelPreferenceRequest,
    ): Promise<UserModelPreferenceResponse> {
      const client = setupApp({ context })(zeroUserModelPreferenceContract);
      const response = await accept(
        client.update({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestUpdateModelPreference(
      actor: ApiTestUser | null,
      body: UpdateUserModelPreferenceRequest,
      statuses: readonly (200 | 400 | 401)[],
    ) {
      const client = setupApp({ context })(zeroUserModelPreferenceContract);
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async rawUpdateModelPreference(
      actor: ApiTestUser,
      body: unknown,
      statuses: readonly (200 | 400 | 401)[],
    ) {
      const client = setupApp({ context })(rawModelPreferenceContract);
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestRegisterPush(
      credential: Credential | null,
      body: RegisterPushBody,
      statuses: readonly (201 | 400 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(pushSubscriptionsContract);
      return await accept(
        client.register({ headers: authenticate(credential), body }),
        statuses,
      );
    },

    async requestUpdatePreferences(
      actor: ApiTestUser | null,
      body: UpdateUserPreferencesRequest,
      statuses: readonly (200 | 400 | 401)[],
    ) {
      const client = setupApp({ context })(zeroUserPreferencesContract);
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestSetVariable(
      actor: ApiTestUser | null,
      body: SetVariableRequest,
      statuses: readonly (200 | 201 | 400 | 401)[],
    ) {
      const client = setupApp({ context })(zeroVariablesContract);
      return await accept(
        client.set({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestDeleteSecret(
      actor: ApiTestUser | null,
      name: string,
      statuses: readonly (204 | 401 | 404)[],
    ) {
      const client = setupApp({ context })(zeroSecretsByNameContract);
      return await accept(
        client.delete({ headers: authenticate(actor), params: { name } }),
        statuses,
      );
    },

    async requestDeleteVariable(
      actor: ApiTestUser | null,
      name: string,
      statuses: readonly (204 | 401 | 404)[],
    ) {
      const client = setupApp({ context })(zeroVariablesByNameContract);
      return await accept(
        client.delete({ headers: authenticate(actor), params: { name } }),
        statuses,
      );
    },

    async requestDeleteApiKey(
      actor: ApiTestUser | null,
      apiKeyId: string,
      statuses: readonly (204 | 401 | 404)[],
    ) {
      const client = setupApp({ context })(apiKeysByIdContract);
      return await accept(
        client.delete({
          headers: authenticate(actor),
          params: { id: apiKeyId },
        }),
        statuses,
      );
    },
  };
}
