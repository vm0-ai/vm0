import { randomUUID } from "node:crypto";

import {
  apiKeysByIdContract,
  apiKeysContract,
  type ApiKeyListResponse,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
} from "@vm0/api-contracts/contracts/api-keys";
import {
  composesByIdContract,
  composesListContract,
  composesMainContract,
  composesMetadataContract,
  type ComposeListItem,
  type ComposeResponse,
  agentComposeApiContentSchema,
} from "@vm0/api-contracts/contracts/composes";
import {
  orgDefaultAgentContract,
  type OrgResponse,
  type UpdateOrgRequest,
} from "@vm0/api-contracts/contracts/orgs";
import type {
  InviteOrgMemberRequest,
  MembershipRequestAction,
  OrgMembersResponse,
  OrgMessageResponse,
  RemoveOrgMemberRequest,
  UpdateOrgMemberRoleRequest,
} from "@vm0/api-contracts/contracts/org-members";
import {
  onboardingSetupContract,
  onboardingStatusContract,
  type OnboardingStatusResponse,
} from "@vm0/api-contracts/contracts/onboarding";
import { authContract } from "@vm0/api-contracts/contracts/auth";
import {
  zeroAgentCustomConnectorsContract,
  type AgentCustomConnectorEnabledIds,
} from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
  type ZeroAgentMetadataRequest,
  type ZeroAgentRequest,
  type ZeroAgentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroComposesByIdContract,
  zeroComposesListContract,
  zeroComposesMainContract,
  zeroComposesMetadataContract,
} from "@vm0/api-contracts/contracts/zero-composes";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
  type PatchCustomConnectorBody,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  zeroOrgContract,
  zeroOrgDeleteContract,
  zeroOrgLeaveContract,
} from "@vm0/api-contracts/contracts/zero-org";
import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";
import { zeroOrgLogoContract } from "@vm0/api-contracts/contracts/zero-org-logo";
import {
  zeroOrgInviteContract,
  zeroOrgMembersContract,
  zeroOrgMembershipRequestsContract,
} from "@vm0/api-contracts/contracts/zero-org-members";
import {
  zeroTeamContract,
  type TeamComposeItem,
} from "@vm0/api-contracts/contracts/zero-team";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  zeroSecretsByNameContract,
  zeroSecretsContract,
  zeroVariablesByNameContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import {
  zeroUserPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type {
  SecretListResponse,
  SecretResponse,
  SetSecretRequest,
} from "@vm0/api-contracts/contracts/secrets";
import type {
  SetVariableRequest,
  VariableListResponse,
  VariableResponse,
} from "@vm0/api-contracts/contracts/variables";
import { HttpResponse, http } from "msw";
import type { z } from "zod";

import { createApp } from "../../../../app-factory";
import { mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./zero-route-test";

type ClerkOrgRole = "org:admin" | "org:member";
type ApiOrgRole = "admin" | "member";
type ComposeContent = z.infer<typeof agentComposeApiContentSchema>;

interface AuthHeaders {
  readonly authorization?: string;
}

interface ClerkEmailAddress {
  readonly id: string;
  readonly emailAddress: string;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly ClerkEmailAddress[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly imageUrl: string;
}

export interface ApiTestUser {
  readonly userId: string;
  readonly orgId: string | null;
  readonly orgRole: ClerkOrgRole | undefined;
  readonly email: string;
}

interface ApiTestUserOptions {
  readonly userId?: string;
  readonly orgId?: string | null;
  readonly orgRole?: ClerkOrgRole;
  readonly email?: string;
}

interface BddOrgMember {
  readonly actor: ApiTestUser;
  readonly role?: ClerkOrgRole;
  readonly joinedAt?: number;
}

interface BddPendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly role?: ClerkOrgRole;
  readonly createdAt?: number;
}

interface BddMembershipRequest {
  readonly id: string;
  readonly actor: ApiTestUser;
  readonly createdAt?: number;
}

interface BddOrgState {
  readonly slug?: string;
  readonly name?: string;
  readonly createdBy?: string;
  readonly createdAt?: number;
  readonly members?: readonly BddOrgMember[];
  readonly pendingInvitations?: readonly BddPendingInvitation[];
  readonly membershipRequests?: readonly BddMembershipRequest[];
}

interface OnboardingSetupBody {
  readonly displayName: string;
  readonly workspaceName?: string;
  readonly sound?: string;
  readonly avatarUrl?: string;
  readonly selectedConnectors?: ConnectorType[];
  readonly timezone?: string;
  readonly role?: string;
}

interface BearerActor {
  readonly bearerToken: string;
}

type LogoUploadActor = ApiTestUser | BearerActor;

type ClerkLogoOperation = "get" | "upload" | "delete";
type ClerkLogoErrorName =
  | "NotFoundError"
  | "BadRequestError"
  | "ForbiddenError";

interface ClerkLogoState {
  readonly imageUrl: string;
  readonly hasImage: boolean;
}

interface MembershipRequestHandlerOptions {
  readonly requests?: readonly BddMembershipRequest[];
  readonly listStatus?: 200 | 404;
  readonly acceptStatus?: 200 | 404;
  readonly rejectStatus?: 200 | 404;
}

interface MembershipRequestCallCounters {
  readonly listCalls: () => number;
  readonly acceptCalls: () => number;
  readonly rejectCalls: () => number;
}

interface RawJsonResponse {
  readonly status: number;
  readonly body: unknown;
}

function isBearerActor(actor: LogoUploadActor): actor is BearerActor {
  return "bearerToken" in actor;
}

function installClerkMembershipRequestHandlers(
  orgId: string,
  options: MembershipRequestHandlerOptions,
): MembershipRequestCallCounters {
  mockEnv("CLERK_SECRET_KEY", "clerk-test-secret");
  const requests = options.requests ?? [];
  const listStatus = options.listStatus ?? 200;
  const acceptStatus = options.acceptStatus ?? 200;
  const rejectStatus = options.rejectStatus ?? 200;
  let listCalls = 0;
  let acceptCalls = 0;
  let rejectCalls = 0;

  server.use(
    http.get(
      "https://api.clerk.com/v1/organizations/:orgId/membership_requests",
      ({ params }) => {
        if (params.orgId !== orgId) {
          return HttpResponse.json({ data: [] });
        }
        listCalls += 1;
        if (listStatus !== 200) {
          return HttpResponse.json(
            { error: "Membership requests unavailable" },
            { status: listStatus },
          );
        }
        return HttpResponse.json({
          data: requests.map((request) => {
            return {
              id: request.id,
              public_user_data: { user_id: request.actor.userId },
              created_at: requestDate(request),
            };
          }),
        });
      },
    ),
    http.post(
      "https://api.clerk.com/v1/organizations/:orgId/membership_requests/:requestId/accept",
      ({ params }) => {
        if (params.orgId !== orgId) {
          return HttpResponse.json({ ok: true });
        }
        acceptCalls += 1;
        if (acceptStatus !== 200) {
          return HttpResponse.json(
            { error: "Membership request not found" },
            { status: acceptStatus },
          );
        }
        return HttpResponse.json({ ok: true });
      },
    ),
    http.post(
      "https://api.clerk.com/v1/organizations/:orgId/membership_requests/:requestId/reject",
      ({ params }) => {
        if (params.orgId !== orgId) {
          return HttpResponse.json({ ok: true });
        }
        rejectCalls += 1;
        if (rejectStatus !== 200) {
          return HttpResponse.json(
            { error: "Membership request not found" },
            { status: rejectStatus },
          );
        }
        return HttpResponse.json({ ok: true });
      },
    ),
  );

  return {
    listCalls: () => {
      return listCalls;
    },
    acceptCalls: () => {
      return acceptCalls;
    },
    rejectCalls: () => {
      return rejectCalls;
    },
  };
}

function roleFromClerk(role: ClerkOrgRole | undefined): ApiOrgRole {
  return role === "org:admin" ? "admin" : "member";
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function bearerHeaders(token: string): AuthHeaders {
  return { authorization: `Bearer ${token}` };
}

function userFrom(options: ApiTestUserOptions = {}): ApiTestUser {
  const userId = options.userId ?? `user_${randomUUID()}`;
  return {
    userId,
    orgId: options.orgId === undefined ? `org_${randomUUID()}` : options.orgId,
    orgRole:
      options.orgRole ?? (options.orgId === null ? undefined : "org:admin"),
    email: options.email ?? `${userId}@example.test`,
  };
}

function clerkProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Actor",
    imageUrl: `https://example.test/${actor.userId}.png`,
  };
}

function recordValue(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  return Reflect.get(source, key);
}

function stringArrayValue(source: unknown, key: string): readonly string[] {
  const value = recordValue(source, key);
  return Array.isArray(value)
    ? value.filter((item): item is string => {
        return typeof item === "string";
      })
    : [];
}

function composeContent(name: string): ComposeContent {
  return {
    version: "1",
    agents: {
      [name]: {
        framework: "claude-code",
        description: "BDD compose agent",
      },
    },
  };
}

function membershipDate(member: BddOrgMember): number {
  return member.joinedAt ?? Date.parse("2026-01-01T00:00:00.000Z");
}

function invitationDate(invitation: BddPendingInvitation): number {
  return invitation.createdAt ?? Date.parse("2026-01-02T00:00:00.000Z");
}

function requestDate(request: BddMembershipRequest): number {
  return request.createdAt ?? Date.parse("2026-01-03T00:00:00.000Z");
}

function defaultOrgMember(actor: ApiTestUser): BddOrgMember {
  return actor.orgRole ? { actor, role: actor.orgRole } : { actor };
}

export function createAuthOrgAgentsBddApi(context: TestContext) {
  const routeMocks = createZeroRouteMocks(context);

  function authenticate(actor: ApiTestUser | null): AuthHeaders {
    if (!actor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return authHeaders(actor);
  }

  function mockClerkUsers(actors: readonly ApiTestUser[]): void {
    const profiles = new Map(
      actors.map((actor) => {
        return [actor.userId, clerkProfile(actor)] as const;
      }),
    );
    const profilesByEmail = new Map(
      actors.map((actor) => {
        return [actor.email, clerkProfile(actor)] as const;
      }),
    );

    context.mocks.clerk.users.getUserList.mockImplementation(
      (input: unknown) => {
        const ids = stringArrayValue(input, "userId");
        if (ids.length > 0) {
          return Promise.resolve({
            data: ids
              .map((id) => {
                return profiles.get(id);
              })
              .filter((profile): profile is ClerkUserProfile => {
                return Boolean(profile);
              }),
          });
        }

        const emails = stringArrayValue(input, "emailAddress");
        if (emails.length > 0) {
          return Promise.resolve({
            data: emails
              .map((email) => {
                return profilesByEmail.get(email);
              })
              .filter((profile): profile is ClerkUserProfile => {
                return Boolean(profile);
              }),
          });
        }

        return Promise.resolve({ data: [...profiles.values()] });
      },
    );
  }

  function clerkLogoMock(operation: ClerkLogoOperation) {
    if (operation === "get") {
      return context.mocks.clerk.organizations.getOrganization;
    }
    if (operation === "upload") {
      return context.mocks.clerk.organizations.updateOrganizationLogo;
    }
    return context.mocks.clerk.organizations.deleteOrganizationLogo;
  }

  async function rawJsonRequest(
    actor: ApiTestUser | null,
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body: Record<string, unknown>,
    statuses: readonly number[],
  ): Promise<RawJsonResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const auth = authenticate(actor);
    if (auth.authorization) {
      headers.authorization = auth.authorization;
    }
    const response = await createApp({ signal: context.signal }).request(path, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    const responseBody: unknown = await response.json();
    if (!statuses.includes(response.status)) {
      throw new Error(
        `Expected raw ${method} ${path} status to be one of ${statuses.join(
          ", ",
        )}, received ${response.status}. Body: ${JSON.stringify(responseBody)}`,
      );
    }
    return { status: response.status, body: responseBody };
  }

  return {
    user: userFrom,

    authenticate,

    acceptAgentStorageWrites(): void {
      context.mocks.s3.send.mockResolvedValue({});
    },

    mockClerkUsers,

    mockClerkOrg(actor: ApiTestUser, state: BddOrgState = {}): void {
      if (!actor.orgId) {
        throw new Error("Cannot mock an organization for a no-org actor");
      }

      const slug = state.slug ?? `bdd-${actor.orgId.slice(-8).toLowerCase()}`;
      const name = state.name ?? "BDD Workspace";
      const createdBy = state.createdBy ?? actor.userId;
      const createdAt =
        state.createdAt ?? Date.parse("2026-01-01T00:00:00.000Z");
      const members = state.members ?? [defaultOrgMember(actor)];
      const pendingInvitations = state.pendingInvitations ?? [];
      const membershipRequests = state.membershipRequests ?? [];
      const orgActors = [
        actor,
        ...members.map((member) => {
          return member.actor;
        }),
        ...membershipRequests.map((request) => {
          return request.actor;
        }),
      ];

      mockClerkUsers(orgActors);
      installClerkMembershipRequestHandlers(actor.orgId, {
        requests: membershipRequests,
      });

      context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
        id: actor.orgId,
        slug,
        name,
        createdBy,
        createdAt,
      });
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: members.map((member) => {
            return {
              role: member.role ?? member.actor.orgRole ?? "org:member",
              organization: { id: actor.orgId, slug, name },
            };
          }),
        },
      );
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        {
          data: members.map((member) => {
            return {
              role: member.role ?? member.actor.orgRole ?? "org:member",
              publicUserData: { userId: member.actor.userId },
              createdAt: membershipDate(member),
            };
          }),
        },
      );
      context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
        {
          data: pendingInvitations.map((invitation) => {
            return {
              id: invitation.id,
              emailAddress: invitation.email,
              role: invitation.role ?? "org:member",
              createdAt: invitationDate(invitation),
            };
          }),
        },
      );
      context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
        {},
      );
      context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValue(
        {},
      );
      context.mocks.clerk.organizations.updateOrganization.mockResolvedValue(
        {},
      );
      context.mocks.clerk.organizations.updateOrganizationMembership.mockResolvedValue(
        {},
      );
      context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValue(
        {},
      );
      context.mocks.clerk.organizations.deleteOrganization.mockResolvedValue(
        {},
      );
    },

    mockClerkMembershipRequestHandlers(
      orgId: string,
      options: MembershipRequestHandlerOptions = {},
    ): MembershipRequestCallCounters {
      return installClerkMembershipRequestHandlers(orgId, options);
    },

    mockClerkOrgLogo(operation: ClerkLogoOperation, state: ClerkLogoState) {
      clerkLogoMock(operation).mockResolvedValue({
        imageUrl: state.imageUrl,
        hasImage: state.hasImage,
      });
    },

    mockClerkLogoError(
      operation: ClerkLogoOperation,
      name: ClerkLogoErrorName,
    ): void {
      const error = new Error(`Clerk organization logo ${operation} failed`);
      error.name = name;
      clerkLogoMock(operation).mockRejectedValue(error);
    },

    async requestReadOrgLogo(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroOrgLogoContract);
      return await accept(
        client.get({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async requestDeleteOrgLogo(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroOrgLogoContract);
      return await accept(
        client.delete({ headers: authenticate(actor) }),
        statuses,
      );
    },

    // Contract clients cannot send multipart bodies, so the logo upload goes
    // through the raw Hono app (requestRawSlackIngress precedent).
    async requestUploadOrgLogo(
      actor: LogoUploadActor | null,
      form: FormData,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ): Promise<RawJsonResponse> {
      const headers: Record<string, string> = {};
      if (actor && isBearerActor(actor)) {
        headers.authorization = `Bearer ${actor.bearerToken}`;
      } else {
        const auth = authenticate(actor);
        if (auth.authorization) {
          headers.authorization = auth.authorization;
        }
      }
      const response = await createApp({ signal: context.signal }).request(
        "/api/zero/org/logo",
        { method: "POST", headers, body: form },
      );
      const body: unknown = await response.json();
      if (!(statuses as readonly number[]).includes(response.status)) {
        throw new Error(
          `Expected POST /api/zero/org/logo status to be one of ${statuses.join(
            ", ",
          )}, received ${response.status}. Body: ${JSON.stringify(body)}`,
        );
      }
      return { status: response.status, body };
    },

    async requestRawJson(
      actor: ApiTestUser | null,
      path: string,
      method: "POST" | "PATCH" | "PUT" | "DELETE",
      body: Record<string, unknown>,
      statuses: readonly number[],
    ): Promise<RawJsonResponse> {
      return await rawJsonRequest(actor, path, method, body, statuses);
    },

    async readMe(actor: ApiTestUser): Promise<{
      readonly userId: string;
      readonly email: string;
    }> {
      mockClerkUsers([actor]);
      const client = setupApp({ context })(authContract);
      const response = await accept(
        client.me({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestReadMe(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      if (actor) {
        mockClerkUsers([actor]);
      }
      const client = setupApp({ context })(authContract);
      return await accept(
        client.me({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async requestReadMeWithBearer(
      token: string,
      profileActor: ApiTestUser,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      mockClerkUsers([profileActor]);
      const client = setupApp({ context })(authContract);
      return await accept(
        client.me({ headers: bearerHeaders(token) }),
        statuses,
      );
    },

    async createApiKey(
      actor: ApiTestUser,
      body: CreateApiKeyRequest,
    ): Promise<CreateApiKeyResponse> {
      const client = setupApp({ context })(apiKeysContract);
      const response = await accept(
        client.create({ headers: authenticate(actor), body }),
        [201],
      );
      return response.body;
    },

    async requestCreateApiKey(
      actor: ApiTestUser | null,
      body: CreateApiKeyRequest,
      statuses: readonly (201 | 400 | 401 | 500)[],
    ) {
      const client = setupApp({ context })(apiKeysContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async listApiKeys(actor: ApiTestUser): Promise<ApiKeyListResponse> {
      const client = setupApp({ context })(apiKeysContract);
      const response = await accept(
        client.list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async deleteApiKey(actor: ApiTestUser, apiKeyId: string): Promise<void> {
      const client = setupApp({ context })(apiKeysByIdContract);
      await accept(
        client.delete({
          headers: authenticate(actor),
          params: { id: apiKeyId },
        }),
        [204],
      );
    },

    async readOnboardingStatus(
      actor: ApiTestUser,
    ): Promise<OnboardingStatusResponse> {
      const client = setupApp({ context })(onboardingStatusContract);
      const response = await accept(
        client.getStatus({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async setupOnboarding(actor: ApiTestUser, body: OnboardingSetupBody) {
      const client = setupApp({ context })(onboardingSetupContract);
      return await accept(
        client.setup({
          headers: authenticate(actor),
          body,
        }),
        [200, 403, 409, 422],
      );
    },

    async requestSetupOnboarding<S extends 200 | 401 | 403 | 409 | 422>(
      actor: ApiTestUser | null,
      body: OnboardingSetupBody,
      statuses: readonly S[],
    ) {
      const client = setupApp({ context })(onboardingSetupContract);
      return await accept(
        client.setup({
          headers: authenticate(actor),
          body,
        }),
        statuses,
      );
    },

    async setSecret(
      actor: ApiTestUser,
      body: SetSecretRequest,
    ): Promise<SecretResponse> {
      const client = setupApp({ context })(zeroSecretsContract);
      const response = await accept(
        client.set({ headers: authenticate(actor), body }),
        [200, 201],
      );
      return response.body;
    },

    async requestSetSecret(
      actor: ApiTestUser | null,
      body: SetSecretRequest,
      statuses: readonly (200 | 201 | 400 | 401 | 500)[],
    ) {
      const client = setupApp({ context })(zeroSecretsContract);
      return await accept(
        client.set({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async listSecrets(actor: ApiTestUser): Promise<SecretListResponse> {
      const client = setupApp({ context })(zeroSecretsContract);
      const response = await accept(
        client.list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async deleteSecret(actor: ApiTestUser, name: string): Promise<void> {
      const client = setupApp({ context })(zeroSecretsByNameContract);
      await accept(
        client.delete({ headers: authenticate(actor), params: { name } }),
        [204],
      );
    },

    async setVariable(
      actor: ApiTestUser,
      body: SetVariableRequest,
    ): Promise<VariableResponse> {
      const client = setupApp({ context })(zeroVariablesContract);
      const response = await accept(
        client.set({ headers: authenticate(actor), body }),
        [200, 201],
      );
      return response.body;
    },

    async listVariables(actor: ApiTestUser): Promise<VariableListResponse> {
      const client = setupApp({ context })(zeroVariablesContract);
      const response = await accept(
        client.list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async deleteVariable(actor: ApiTestUser, name: string): Promise<void> {
      const client = setupApp({ context })(zeroVariablesByNameContract);
      await accept(
        client.delete({ headers: authenticate(actor), params: { name } }),
        [204],
      );
    },

    async readPreferences(
      actor: ApiTestUser,
    ): Promise<UserPreferencesResponse> {
      const client = setupApp({ context })(zeroUserPreferencesContract);
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async updatePreferences(
      actor: ApiTestUser,
      body: UpdateUserPreferencesRequest,
    ): Promise<UserPreferencesResponse> {
      const client = setupApp({ context })(zeroUserPreferencesContract);
      const response = await accept(
        client.update({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async readOrg(actor: ApiTestUser): Promise<OrgResponse> {
      const client = setupApp({ context })(zeroOrgContract);
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestReadOrg(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404)[],
    ) {
      const client = setupApp({ context })(zeroOrgContract);
      return await accept(
        client.get({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async updateOrg(
      actor: ApiTestUser,
      body: UpdateOrgRequest,
    ): Promise<OrgResponse> {
      const client = setupApp({ context })(zeroOrgContract);
      const response = await accept(
        client.update({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestUpdateOrg(
      actor: ApiTestUser | null,
      body: UpdateOrgRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500)[],
    ) {
      const client = setupApp({ context })(zeroOrgContract);
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async listOrgs(actor: ApiTestUser) {
      const client = setupApp({ context })(zeroOrgListContract);
      const response = await accept(
        client.list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async listMembers(actor: ApiTestUser): Promise<OrgMembersResponse> {
      const client = setupApp({ context })(zeroOrgMembersContract);
      const response = await accept(
        client.members({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestReadOrgWithBearer(
      token: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroOrgContract);
      return await accept(
        client.get({ headers: bearerHeaders(token) }),
        statuses,
      );
    },

    async requestUpdateOrgWithBearer(
      token: string,
      body: UpdateOrgRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 500)[],
    ) {
      const client = setupApp({ context })(zeroOrgContract);
      return await accept(
        client.update({ headers: bearerHeaders(token), body }),
        statuses,
      );
    },

    async requestListMembersWithBearer<
      S extends 200 | 400 | 401 | 403 | 404 | 500,
    >(token: string, statuses: readonly S[]) {
      const client = setupApp({ context })(zeroOrgMembersContract);
      return await accept(
        client.members({ headers: bearerHeaders(token) }),
        statuses,
      );
    },

    async inviteMember(
      actor: ApiTestUser,
      body: InviteOrgMemberRequest,
    ): Promise<OrgMessageResponse> {
      const client = setupApp({ context })(zeroOrgInviteContract);
      const response = await accept(
        client.invite({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestInviteMember(
      actor: ApiTestUser | null,
      body: InviteOrgMemberRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroOrgInviteContract);
      return await accept(
        client.invite({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async revokeInvitation(
      actor: ApiTestUser,
      invitationId: string,
    ): Promise<OrgMessageResponse> {
      const client = setupApp({ context })(zeroOrgInviteContract);
      const response = await accept(
        client.revoke({
          headers: authenticate(actor),
          body: { invitationId },
        }),
        [200],
      );
      return response.body;
    },

    async requestRevokeInvitation(
      actor: ApiTestUser | null,
      invitationId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroOrgInviteContract);
      return await accept(
        client.revoke({
          headers: authenticate(actor),
          body: { invitationId },
        }),
        statuses,
      );
    },

    async updateMemberRole(
      actor: ApiTestUser,
      body: UpdateOrgMemberRoleRequest,
    ): Promise<OrgMessageResponse> {
      const client = setupApp({ context })(zeroOrgMembersContract);
      const response = await accept(
        client.updateRole({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestUpdateMemberRole(
      actor: ApiTestUser | null,
      body: UpdateOrgMemberRoleRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(zeroOrgMembersContract);
      return await accept(
        client.updateRole({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async removeMember(
      actor: ApiTestUser,
      body: RemoveOrgMemberRequest,
    ): Promise<OrgMessageResponse> {
      const client = setupApp({ context })(zeroOrgMembersContract);
      const response = await accept(
        client.removeMember({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestRemoveMember(
      actor: ApiTestUser | null,
      body: RemoveOrgMemberRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupApp({ context })(zeroOrgMembersContract);
      return await accept(
        client.removeMember({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async acceptMembershipRequest(
      actor: ApiTestUser,
      body: MembershipRequestAction,
    ): Promise<OrgMessageResponse> {
      const client = setupApp({ context })(zeroOrgMembershipRequestsContract);
      const response = await accept(
        client.accept({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async rejectMembershipRequest(
      actor: ApiTestUser,
      body: MembershipRequestAction,
    ): Promise<OrgMessageResponse> {
      const client = setupApp({ context })(zeroOrgMembershipRequestsContract);
      const response = await accept(
        client.reject({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestAcceptMembershipRequest(
      actor: ApiTestUser | null,
      body: MembershipRequestAction,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroOrgMembershipRequestsContract);
      return await accept(
        client.accept({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestRejectMembershipRequest(
      actor: ApiTestUser | null,
      body: MembershipRequestAction,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroOrgMembershipRequestsContract);
      return await accept(
        client.reject({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async leaveOrg(actor: ApiTestUser): Promise<OrgMessageResponse> {
      const client = setupApp({ context })(zeroOrgLeaveContract);
      const response = await accept(
        client.leave({ headers: authenticate(actor), body: {} }),
        [200],
      );
      return response.body;
    },

    async requestLeaveOrg(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(zeroOrgLeaveContract);
      return await accept(
        client.leave({ headers: authenticate(actor), body: {} }),
        statuses,
      );
    },

    async deleteOrg(
      actor: ApiTestUser,
      slug: string,
    ): Promise<OrgMessageResponse> {
      const client = setupApp({ context })(zeroOrgDeleteContract);
      const response = await accept(
        client.delete({ headers: authenticate(actor), body: { slug } }),
        [200],
      );
      return response.body;
    },

    async requestDeleteOrg(
      actor: ApiTestUser | null,
      slug: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroOrgDeleteContract);
      return await accept(
        client.delete({ headers: authenticate(actor), body: { slug } }),
        statuses,
      );
    },

    async listTeam(actor: ApiTestUser): Promise<readonly TeamComposeItem[]> {
      const client = setupApp({ context })(zeroTeamContract);
      const response = await accept(
        client.list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestListTeam(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(zeroTeamContract);
      return await accept(
        client.list({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async readEnabledConnectorTypes(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly string[]> {
      const client = setupApp({ context })(zeroUserConnectorsContract);
      const response = await accept(
        client.get({
          headers: authenticate(actor),
          params: { id: agentId },
        }),
        [200],
      );
      return response.body.enabledTypes;
    },

    async createAgent(
      actor: ApiTestUser,
      body: ZeroAgentRequest = {},
    ): Promise<ZeroAgentResponse> {
      const client = setupApp({ context })(zeroAgentsMainContract);
      const response = await accept(
        client.create({ headers: authenticate(actor), body }),
        [201],
      );
      return response.body;
    },

    async requestCreateAgent(
      actor: ApiTestUser | null,
      body: ZeroAgentRequest,
      statuses: readonly (201 | 400 | 401 | 403 | 409 | 422)[],
    ) {
      const client = setupApp({ context })(zeroAgentsMainContract);
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async listAgents(
      actor: ApiTestUser,
    ): Promise<readonly ZeroAgentResponse[]> {
      const client = setupApp({ context })(zeroAgentsMainContract);
      const response = await accept(
        client.list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async readAgent(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<ZeroAgentResponse> {
      const client = setupApp({ context })(zeroAgentsByIdContract);
      const response = await accept(
        client.get({ params: { id: agentId }, headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestReadAgent(
      actor: ApiTestUser | null,
      agentId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroAgentsByIdContract);
      return await accept(
        client.get({ params: { id: agentId }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async updateAgentMetadata(
      actor: ApiTestUser,
      agentId: string,
      body: ZeroAgentMetadataRequest,
    ): Promise<ZeroAgentResponse> {
      const client = setupApp({ context })(zeroAgentsByIdContract);
      const response = await accept(
        client.updateMetadata({
          params: { id: agentId },
          headers: authenticate(actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestUpdateAgentMetadata(
      actor: ApiTestUser | null,
      agentId: string,
      body: ZeroAgentMetadataRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      const client = setupApp({ context })(zeroAgentsByIdContract);
      return await accept(
        client.updateMetadata({
          params: { id: agentId },
          headers: authenticate(actor),
          body,
        }),
        statuses,
      );
    },

    async deleteAgent(actor: ApiTestUser, agentId: string): Promise<void> {
      const client = setupApp({ context })(zeroAgentsByIdContract);
      await accept(
        client.delete({
          params: { id: agentId },
          headers: authenticate(actor),
        }),
        [204],
      );
    },

    async requestDeleteAgent(
      actor: ApiTestUser | null,
      agentId: string,
      statuses: readonly (204 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      const client = setupApp({ context })(zeroAgentsByIdContract);
      return await accept(
        client.delete({
          params: { id: agentId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async setDefaultAgent(
      actor: ApiTestUser,
      agentId: string | null,
    ): Promise<{ readonly agentId: string | null }> {
      const client = setupApp({ context })(orgDefaultAgentContract);
      const response = await accept(
        client.setDefaultAgent({
          headers: authenticate(actor),
          query: {},
          body: { agentId },
        }),
        [200],
      );
      return response.body;
    },

    async requestSetDefaultAgent(
      actor: ApiTestUser | null,
      agentId: string | null,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      const client = setupApp({ context })(orgDefaultAgentContract);
      return await accept(
        client.setDefaultAgent({
          headers: authenticate(actor),
          query: {},
          body: { agentId },
        }),
        statuses,
      );
    },

    composeContent,

    async createCompose(
      actor: ApiTestUser,
      content: ComposeContent,
    ): Promise<{
      readonly composeId: string;
      readonly name: string;
      readonly versionId: string;
      readonly action: "created" | "existing";
      readonly updatedAt: string;
    }> {
      const client = setupApp({ context })(composesMainContract);
      const response = await accept(
        client.create({ headers: authenticate(actor), body: { content } }),
        [200, 201],
      );
      return response.body;
    },

    async requestCreateCompose(
      actor: ApiTestUser | null,
      content: ComposeContent,
      statuses: readonly (200 | 201 | 400 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(composesMainContract);
      return await accept(
        client.create({ headers: authenticate(actor), body: { content } }),
        statuses,
      );
    },

    async readComposeById(
      actor: ApiTestUser,
      composeId: string,
    ): Promise<ComposeResponse> {
      const client = setupApp({ context })(composesByIdContract);
      const response = await accept(
        client.getById({
          headers: authenticate(actor),
          params: { id: composeId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadComposeById(
      actor: ApiTestUser | null,
      composeId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(composesByIdContract);
      return await accept(
        client.getById({
          headers: authenticate(actor),
          params: { id: composeId },
        }),
        statuses,
      );
    },

    async readComposeByName(
      actor: ApiTestUser,
      name: string,
    ): Promise<ComposeResponse> {
      const client = setupApp({ context })(composesMainContract);
      const response = await accept(
        client.getByName({
          headers: authenticate(actor),
          query: { name },
        }),
        [200],
      );
      return response.body;
    },

    async listComposes(
      actor: ApiTestUser,
    ): Promise<readonly ComposeListItem[]> {
      const client = setupApp({ context })(composesListContract);
      const response = await accept(
        client.list({ headers: authenticate(actor), query: {} }),
        [200],
      );
      return response.body.composes;
    },

    async updateComposeMetadata(
      actor: ApiTestUser,
      composeId: string,
      body: {
        readonly displayName?: string;
        readonly description?: string;
        readonly sound?: string;
      },
    ): Promise<void> {
      const client = setupApp({ context })(composesMetadataContract);
      await accept(
        client.updateMetadata({
          headers: authenticate(actor),
          params: { id: composeId },
          body,
        }),
        [200],
      );
    },

    async deleteCompose(actor: ApiTestUser, composeId: string): Promise<void> {
      const client = setupApp({ context })(composesByIdContract);
      await accept(
        client.delete({
          headers: authenticate(actor),
          params: { id: composeId },
        }),
        [204],
      );
    },

    async readZeroComposeById(
      actor: ApiTestUser,
      composeId: string,
    ): Promise<ComposeResponse> {
      const client = setupApp({ context })(zeroComposesByIdContract);
      const response = await accept(
        client.getById({
          headers: authenticate(actor),
          params: { id: composeId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadZeroComposeById(
      actor: ApiTestUser | null,
      composeId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroComposesByIdContract);
      return await accept(
        client.getById({
          headers: authenticate(actor),
          params: { id: composeId },
        }),
        statuses,
      );
    },

    async readZeroComposeByName(
      actor: ApiTestUser,
      name: string,
    ): Promise<ComposeResponse> {
      const client = setupApp({ context })(zeroComposesMainContract);
      const response = await accept(
        client.getByName({
          headers: authenticate(actor),
          query: { name },
        }),
        [200],
      );
      return response.body;
    },

    async listZeroComposes(
      actor: ApiTestUser,
    ): Promise<readonly ComposeListItem[]> {
      const client = setupApp({ context })(zeroComposesListContract);
      const response = await accept(
        client.list({ headers: authenticate(actor), query: {} }),
        [200],
      );
      return response.body.composes;
    },

    async updateZeroComposeMetadata(
      actor: ApiTestUser,
      composeId: string,
      body: {
        readonly displayName?: string | null;
        readonly description?: string | null;
        readonly sound?: string | null;
      },
    ): Promise<void> {
      const client = setupApp({ context })(zeroComposesMetadataContract);
      await accept(
        client.update({
          headers: authenticate(actor),
          params: { id: composeId },
          body,
        }),
        [200],
      );
    },

    async deleteZeroCompose(
      actor: ApiTestUser,
      composeId: string,
    ): Promise<void> {
      const client = setupApp({ context })(zeroComposesByIdContract);
      await accept(
        client.delete({
          headers: authenticate(actor),
          params: { id: composeId },
        }),
        [204],
      );
    },

    async createCustomConnector(
      actor: ApiTestUser,
      body: CreateCustomConnectorBody,
    ): Promise<CustomConnectorResponse> {
      const client = setupApp({ context })(zeroCustomConnectorsContract);
      const response = await accept(
        client.create({ headers: authenticate(actor), body }),
        [201],
      );
      return response.body;
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

    async listCustomConnectors(actor: ApiTestUser): Promise<{
      readonly connectors: readonly CustomConnectorResponse[];
    }> {
      const client = setupApp({ context })(zeroCustomConnectorsContract);
      const response = await accept(
        client.list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async patchCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
      body: PatchCustomConnectorBody,
    ): Promise<CustomConnectorResponse> {
      const client = setupApp({ context })(zeroCustomConnectorByIdContract);
      const response = await accept(
        client.patch({
          headers: authenticate(actor),
          params: { id: connectorId },
          body,
        }),
        [200],
      );
      return response.body;
    },

    async setCustomConnectorSecret(
      actor: ApiTestUser,
      connectorId: string,
      value: string,
    ): Promise<void> {
      const client = setupApp({ context })(zeroCustomConnectorSecretContract);
      await accept(
        client.set({
          headers: authenticate(actor),
          params: { id: connectorId },
          body: { value },
        }),
        [204],
      );
    },

    async deleteCustomConnectorSecret(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<void> {
      const client = setupApp({ context })(zeroCustomConnectorSecretContract);
      await accept(
        client.delete({
          headers: authenticate(actor),
          params: { id: connectorId },
        }),
        [204],
      );
    },

    async deleteCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<void> {
      const client = setupApp({ context })(zeroCustomConnectorByIdContract);
      await accept(
        client.delete({
          headers: authenticate(actor),
          params: { id: connectorId },
        }),
        [204],
      );
    },

    async readAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<AgentCustomConnectorEnabledIds> {
      const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
      const response = await accept(
        client.get({
          headers: authenticate(actor),
          params: { id: agentId },
        }),
        [200],
      );
      return response.body;
    },

    async updateAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
      enabledIds: readonly string[],
    ): Promise<AgentCustomConnectorEnabledIds> {
      const client = setupApp({ context })(zeroAgentCustomConnectorsContract);
      const response = await accept(
        client.update({
          headers: authenticate(actor),
          params: { id: agentId },
          body: { enabledIds: [...enabledIds] },
        }),
        [200],
      );
      return response.body;
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
          headers: authenticate(actor),
          params: { id: agentId },
          body: { enabledIds: [...enabledIds] },
        }),
        statuses,
      );
    },

    roleFromClerk,
  };
}
