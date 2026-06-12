import {
  logsByIdContract,
  logsListContract,
} from "@vm0/api-contracts/contracts/logs";
import { emailUnsubscribeContract } from "@vm0/api-contracts/contracts/email-unsubscribe";
import { pushSubscriptionsContract } from "@vm0/api-contracts/contracts/push-subscriptions";
import { userExportContract } from "@vm0/api-contracts/contracts/user-export";
import type {
  OrgModelPoliciesResponse,
  UpsertModelProviderRequest,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
  type SkillFileEntry,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import {
  zeroModelProvidersByTypeContract,
  zeroModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-model-providers";
import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { zeroOrgLogoContract } from "@vm0/api-contracts/contracts/zero-org-logo";
import {
  zeroUserPreferencesContract,
  type UpdateUserPreferencesRequest,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import { zeroLogsSearchContract } from "@vm0/api-contracts/contracts/zero-runs";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

interface ClerkOrg {
  readonly imageUrl: string | null;
  readonly hasImage: boolean;
}

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

function skillFiles(content: string): SkillFileEntry[] {
  return [{ path: "SKILL.md", content }];
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function bodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.alloc(0);
}

function asyncIterableOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

export function createMiscRoutesApi(context: TestContext) {
  const s3Objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const key = typeof input.Key === "string" ? input.Key : "";
    const name = commandName(command);
    if (name === "PutObjectCommand") {
      s3Objects.set(key, bodyBuffer(input.Body));
      return Promise.resolve({});
    }
    if (name === "GetObjectCommand") {
      const body = s3Objects.get(key);
      return Promise.resolve(
        body ? { Body: asyncIterableOf(body) } : { Body: undefined },
      );
    }
    if (name === "HeadObjectCommand") {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });

  return {
    setOrgLogoRead(org: ClerkOrg): void {
      context.mocks.clerk.organizations.getOrganization.mockResolvedValue(org);
    },

    setOrgLogoUpload(org: ClerkOrg): void {
      context.mocks.clerk.organizations.updateOrganizationLogo.mockResolvedValue(
        org,
      );
    },

    setOrgLogoDelete(org: ClerkOrg): void {
      context.mocks.clerk.organizations.deleteOrganizationLogo.mockResolvedValue(
        org,
      );
    },

    async requestOrgLogo(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(zeroOrgLogoContract).get({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async uploadOrgLogo(
      actor: ApiTestUser,
      file: File | null,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const body = new FormData();
      if (file) {
        body.append("file", file);
      }
      return await accept(
        setupApp({ context })(zeroOrgLogoContract).post({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async deleteOrgLogo(
      actor: ApiTestUser,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(zeroOrgLogoContract).delete({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async readPreferences(actor: ApiTestUser) {
      return await accept(
        setupApp({ context })(zeroUserPreferencesContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async updatePreferences(
      actor: ApiTestUser,
      body: UpdateUserPreferencesRequest,
      statuses: readonly (200 | 400 | 401 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(zeroUserPreferencesContract).update({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async registerPush(
      actor: ApiTestUser | null,
      statuses: readonly (201 | 400 | 401 | 403)[],
    ) {
      return await accept(
        setupApp({ context })(pushSubscriptionsContract).register({
          headers: authenticate(context, actor),
          body: {
            endpoint: `https://push.example.test/${actor?.userId ?? "anon"}`,
            keys: { p256dh: "bdd-p256dh", auth: "bdd-auth" },
          },
        }),
        statuses,
      );
    },

    async readUserExport(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(userExportContract).get({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async startUserExport(
      actor: ApiTestUser | null,
      statuses: readonly (202 | 401 | 403 | 429 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(userExportContract).post({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async requestEmailUnsubscribePage(
      token: string | undefined,
      statuses: readonly (200 | 400)[],
    ) {
      return await accept(
        setupApp({ context })(emailUnsubscribeContract).get({
          query: { token },
        }),
        statuses,
      );
    },

    async requestEmailUnsubscribe(
      token: string | undefined,
      statuses: readonly (200 | 400)[],
    ) {
      return await accept(
        setupApp({ context })(emailUnsubscribeContract).unsubscribe({
          query: { token },
        }),
        statuses,
      );
    },

    async listSkills(actor: ApiTestUser) {
      return await accept(
        setupApp({ context })(zeroSkillsCollectionContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async createSkill(
      actor: ApiTestUser,
      name: string,
      content: string,
      statuses: readonly (201 | 400 | 401 | 403 | 409)[],
    ) {
      return await accept(
        setupApp({ context })(zeroSkillsCollectionContract).create({
          headers: authenticate(context, actor),
          body: {
            name,
            displayName: "BDD Skill",
            description: "Created through public skill API",
            files: skillFiles(content),
          },
        }),
        statuses,
      );
    },

    async requestCreateInvalidSkill(
      actor: ApiTestUser,
      statuses: readonly (400 | 401 | 403 | 409)[],
    ) {
      return await accept(
        setupApp({ context })(zeroSkillsCollectionContract).create({
          headers: authenticate(context, actor),
          body: {
            name: "bdd-invalid-skill",
            files: [{ path: "README.md", content: "missing skill file" }],
          },
        }),
        statuses,
      );
    },

    async readSkill(
      actor: ApiTestUser,
      name: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(zeroSkillsDetailContract).get({
          headers: authenticate(context, actor),
          params: { name },
        }),
        statuses,
      );
    },

    async updateSkill(
      actor: ApiTestUser,
      name: string,
      content: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(zeroSkillsDetailContract).update({
          headers: authenticate(context, actor),
          params: { name },
          body: { files: skillFiles(content) },
        }),
        statuses,
      );
    },

    async deleteSkill(
      actor: ApiTestUser,
      name: string,
      statuses: readonly (204 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(zeroSkillsDetailContract).delete({
          headers: authenticate(context, actor),
          params: { name },
        }),
        statuses,
      );
    },

    async listModelProviders(actor: ApiTestUser) {
      return await accept(
        setupApp({ context })(zeroModelProvidersMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async upsertVm0Provider(
      actor: ApiTestUser,
      statuses: readonly (200 | 201 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(zeroModelProvidersMainContract).upsert({
          headers: authenticate(context, actor),
          body: { type: "vm0" },
        }),
        statuses,
      );
    },

    async deleteVm0Provider(
      actor: ApiTestUser,
      statuses: readonly (204 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(zeroModelProvidersByTypeContract).delete({
          headers: authenticate(context, actor),
          params: { type: "vm0" },
        }),
        statuses,
      );
    },

    async listPersonalModelProviders(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(zeroPersonalModelProvidersMainContract).list({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async upsertPersonalModelProvider(
      actor: ApiTestUser | null,
      body: UpsertModelProviderRequest,
      statuses: readonly (200 | 201 | 400 | 401 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(zeroPersonalModelProvidersMainContract).upsert({
          headers: authenticate(context, actor),
          body,
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
        setupApp({ context })(zeroPersonalModelProvidersByTypeContract).delete({
          headers: authenticate(context, actor),
          params: { type },
        }),
        statuses,
      );
    },

    async listModelPolicies(
      actor: ApiTestUser,
    ): Promise<OrgModelPoliciesResponse> {
      const response = await accept(
        setupApp({ context })(zeroModelPoliciesMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },

    async updateModelPolicies(
      actor: ApiTestUser,
      policies: OrgModelPoliciesResponse["policies"],
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        setupApp({ context })(zeroModelPoliciesMainContract).update({
          headers: authenticate(context, actor),
          body: {
            policies: policies.map((policy) => {
              return {
                model: policy.model,
                isDefault: policy.isDefault,
                defaultProviderType: policy.defaultProviderType,
                credentialScope: policy.credentialScope,
                modelProviderId: policy.modelProviderId,
              };
            }),
          },
        }),
        statuses,
      );
    },

    async listLogs(actor: ApiTestUser) {
      return await accept(
        setupApp({ context })(logsListContract).list({
          headers: authenticate(context, actor),
          query: {},
        }),
        [200],
      );
    },

    async searchLogs(actor: ApiTestUser, keyword: string) {
      return await accept(
        setupApp({ context })(zeroLogsSearchContract).searchLogs({
          headers: authenticate(context, actor),
          query: { keyword },
        }),
        [200],
      );
    },

    async readLog(
      actor: ApiTestUser,
      id: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        setupApp({ context })(logsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id },
        }),
        statuses,
      );
    },
  };
}
