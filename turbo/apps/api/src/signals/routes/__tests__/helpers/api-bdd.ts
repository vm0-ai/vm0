import { randomUUID } from "node:crypto";

import {
  apiKeysByIdContract,
  apiKeysContract,
} from "@vm0/api-contracts/contracts/api-keys";
import {
  chatThreadByIdContract,
  chatThreadModelSelectionContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadsContract,
  chatThreadUnpinContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";
import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";
import { authContract } from "@vm0/api-contracts/contracts/auth";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
  zeroSkillsCollectionContract,
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
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  zeroSecretsByNameContract,
  zeroSecretsContract,
  zeroVariablesByNameContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";

import { setupApp, type TestContext } from "../../../../__tests__/test-helpers";
import { now } from "../../../../lib/time";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import { createZeroRouteMocks } from "./zero-route-test";

/**
 * API-first BDD harness for route tests. Every interaction goes through a real
 * HTTP request via `setupApp`; the only thing mocked here are external services
 * (Clerk session resolution, S3 uploads) through `context.mocks`. There are no
 * database writers or readers — preconditions and assertions must be expressed
 * as real API calls by the test, per the migration plan in `api.bdd.md`.
 */
export const SESSION_AUTH = {
  authorization: "Bearer clerk-session",
} as const;

interface BddActor {
  readonly userId: string;
  readonly orgId: string;
}

function newOrgId(): string {
  return `org_${randomUUID()}`;
}

function newUserId(): string {
  return `user_${randomUUID()}`;
}

export function createBddApi(context: TestContext) {
  const mocks = createZeroRouteMocks(context);

  return {
    /** ts-rest client for `/api/zero/agents` (create + list). */
    agents: setupApp({ context })(zeroAgentsMainContract),
    /** ts-rest client for `/api/zero/agents/:id` (get/update/patch/delete). */
    agentsById: setupApp({ context })(zeroAgentsByIdContract),
    /** ts-rest client for `/api/zero/skills` (create), used to build the
     * `customSkills` precondition through the public API. */
    skills: setupApp({ context })(zeroSkillsCollectionContract),
    /** ts-rest client for `/api/zero/custom-connectors` (create/list), used to
     * build the org custom-connector precondition through the public API. */
    customConnectors: setupApp({ context })(zeroCustomConnectorsContract),
    /** ts-rest client for `/api/zero/custom-connectors/:id/secret` (set/delete
     * a per-user secret on a custom connector). */
    customConnectorSecret: setupApp({ context })(
      zeroCustomConnectorSecretContract,
    ),
    /** ts-rest client for `/api/zero/custom-connectors/:id` (patch/delete). */
    customConnectorById: setupApp({ context })(zeroCustomConnectorByIdContract),
    /** ts-rest client for `/api/zero/agents/:id/custom-connectors`
     * (get/update the connectors enabled on an agent). */
    agentCustomConnectors: setupApp({ context })(
      zeroAgentCustomConnectorsContract,
    ),
    /** ts-rest client for `/api/zero/agents/:id/user-connectors`
     * (get/update the built-in connector types enabled on an agent). */
    agentUserConnectors: setupApp({ context })(zeroUserConnectorsContract),
    /** ts-rest client for `/api/zero/variables` (list/set user variables). */
    variables: setupApp({ context })(zeroVariablesContract),
    /** ts-rest client for `/api/zero/variables/:name` (delete a variable). */
    variableByName: setupApp({ context })(zeroVariablesByNameContract),
    /** ts-rest client for `/api/zero/secrets` (list/set user secrets). */
    secrets: setupApp({ context })(zeroSecretsContract),
    /** ts-rest client for `/api/zero/secrets/:name` (delete a secret). */
    secretByName: setupApp({ context })(zeroSecretsByNameContract),
    /** ts-rest client for `/api/zero/user-preferences` (get/update). */
    userPreferences: setupApp({ context })(zeroUserPreferencesContract),
    /** ts-rest client for `/api/zero/user-model-preference` (get/update the
     * caller's model-first pin). */
    userModelPreference: setupApp({ context })(zeroUserModelPreferenceContract),
    /** ts-rest client for `/api/zero/feature-switches` (get/update/delete). */
    featureSwitches: setupApp({ context })(zeroFeatureSwitchesContract),
    /** ts-rest client for `/api/zero/api-keys` (list/create personal tokens). */
    apiKeys: setupApp({ context })(apiKeysContract),
    /** ts-rest client for `/api/zero/api-keys/:id` (delete a token). */
    apiKeyById: setupApp({ context })(apiKeysByIdContract),
    /** ts-rest client for `/api/zero/me/model-providers` (list/upsert). */
    personalModelProviders: setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    ),
    /** ts-rest client for `/api/zero/me/model-providers/:type` (delete). */
    personalModelProviderByType: setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    ),
    /** ts-rest client for `/api/zero/composes/:id` (read/delete a compose). */
    composesById: setupApp({ context })(zeroComposesByIdContract),
    /** ts-rest client for `/api/zero/composes` (list org composes). */
    composesList: setupApp({ context })(zeroComposesListContract),
    /** ts-rest client for `/api/zero/composes` getByName. */
    composesMain: setupApp({ context })(zeroComposesMainContract),
    /** ts-rest client for `/api/zero/composes/:id/metadata` (update). */
    composesMetadata: setupApp({ context })(zeroComposesMetadataContract),
    /** ts-rest client for `/api/zero/chat-threads` (create + list). */
    chatThreads: setupApp({ context })(chatThreadsContract),
    /** ts-rest client for `/api/zero/chat-threads/:id` (get/patch/delete). */
    chatThreadById: setupApp({ context })(chatThreadByIdContract),
    /** ts-rest client for `/api/zero/chat-threads/:id/pin`. */
    chatThreadPin: setupApp({ context })(chatThreadPinContract),
    /** ts-rest client for `/api/zero/chat-threads/:id/unpin`. */
    chatThreadUnpin: setupApp({ context })(chatThreadUnpinContract),
    /** ts-rest client for `/api/zero/chat-threads/:id/rename`. */
    chatThreadRename: setupApp({ context })(chatThreadRenameContract),
    /** ts-rest client for `/api/zero/chat-threads/:id/model-selection`. */
    chatThreadModelSelection: setupApp({ context })(
      chatThreadModelSelectionContract,
    ),
    /** ts-rest client for `/api/zero/org/list` (list the caller's orgs). */
    orgList: setupApp({ context })(zeroOrgListContract),
    /** ts-rest client for `/api/zero/attribution/signup` (record first-touch
     * signup attribution into Clerk private metadata). */
    attribution: setupApp({ context })(zeroAttributionContract),
    /** ts-rest client for `/api/auth/me` (resolve the caller's id + email). */
    authMe: setupApp({ context })(authContract),

    /** Authorization header for the active Clerk session actor. */
    auth: SESSION_AUTH,

    /** Mock a Clerk admin session and return the acting identity. */
    actAsAdmin(actor: Partial<BddActor> = {}): BddActor {
      const identity: BddActor = {
        userId: actor.userId ?? newUserId(),
        orgId: actor.orgId ?? newOrgId(),
      };
      mocks.clerk.session(identity.userId, identity.orgId, "org:admin");
      return identity;
    },

    /** Mock a Clerk session for a non-admin member of `actor.orgId`. */
    actAsMember(actor: BddActor): BddActor {
      mocks.clerk.session(actor.userId, actor.orgId, "org:member");
      return actor;
    },

    /** Mock a Clerk session with no active organization. */
    actAsNoOrg(userId: string = newUserId()): void {
      mocks.clerk.session(userId, null);
    },

    /** Mock the caller's Clerk organization memberships (the external source of
     * truth for `/api/zero/org/list`). Clerk owns org membership, so there is
     * no in-app API to create it — mocking the provider is the precondition. */
    mockOrgMemberships(
      memberships: readonly {
        readonly orgId: string;
        readonly slug: string;
        readonly role: "org:admin" | "org:member";
      }[],
    ): void {
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: memberships.map((membership) => {
            return {
              organization: { id: membership.orgId, slug: membership.slug },
              role: membership.role,
            };
          }),
        },
      );
    },

    /** Mock the Clerk user lookup so a route that reads/writes Clerk private
     * metadata sees `privateMetadata` for `userId`, and allow the write. Clerk
     * owns this profile data, so it is an external precondition to mock. */
    mockClerkUserPrivateMetadata(
      userId: string,
      privateMetadata: Record<string, unknown>,
    ): void {
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [{ id: userId, privateMetadata }],
      });
      context.mocks.clerk.users.updateUser.mockResolvedValue({});
    },

    /** Build an `Authorization` header for a sandbox "zero" token carrying the
     * given capabilities — used to exercise capability-gated 403 branches. */
    zeroAuth(capabilities: readonly ZeroCapability[]): {
      readonly authorization: string;
    } {
      const seconds = Math.floor(now() / 1000);
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId: newUserId(),
        orgId: newOrgId(),
        runId: `run_${randomUUID()}`,
        capabilities: [...capabilities],
        iat: seconds,
        exp: seconds + 60,
      });
      return { authorization: `Bearer ${token}` };
    },

    /** Build an `Authorization` header for a sandbox-scoped token bound to a
     * known `userId` (so a Clerk profile mock for that user can be matched). */
    sandboxAuth(userId: string): { readonly authorization: string } {
      const seconds = Math.floor(now() / 1000);
      const token = signSandboxJwtForTests({
        scope: "sandbox",
        userId,
        orgId: newOrgId(),
        runId: `run_${randomUUID()}`,
        iat: seconds,
        exp: seconds + 60,
      });
      return { authorization: `Bearer ${token}` };
    },

    /** Build an `Authorization` header for a zero-scoped token bound to a known
     * `userId` and carrying the given capabilities. */
    zeroAuthFor(
      userId: string,
      capabilities: readonly ZeroCapability[],
    ): { readonly authorization: string } {
      const seconds = Math.floor(now() / 1000);
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId,
        orgId: newOrgId(),
        runId: `run_${randomUUID()}`,
        capabilities: [...capabilities],
        iat: seconds,
        exp: seconds + 60,
      });
      return { authorization: `Bearer ${token}` };
    },

    /** Mock the Clerk profile lookup so a route that resolves a user's email
     * (e.g. `/api/auth/me`) sees a primary email for `userId`. Clerk owns the
     * profile, so it is an external precondition to mock. */
    mockClerkUserEmail(
      userId: string,
      email: string,
      name: { readonly firstName?: string; readonly lastName?: string } = {},
    ): void {
      const emailId = `email_${userId}`;
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [
          {
            id: userId,
            firstName: name.firstName ?? null,
            lastName: name.lastName ?? null,
            emailAddresses: [{ id: emailId, emailAddress: email }],
            primaryEmailAddressId: emailId,
          },
        ],
      });
    },

    /** Stub S3 so the instructions-storage upload during agent creation
     * succeeds (the only external dependency the create path touches). */
    allowInstructionsStorage(): void {
      context.mocks.s3.send.mockResolvedValue({});
    },
  };
}
