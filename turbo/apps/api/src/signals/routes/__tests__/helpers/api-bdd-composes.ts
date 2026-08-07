import { agentComposeApiContentSchema } from "@vm0/api-contracts/contracts/composes";
import { zeroComposesListContract } from "@vm0/api-contracts/contracts/zero-composes";
import type { z } from "zod";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import {
  createAgentComposeFixture,
  readAgentComposeByIdFixture,
  readAgentComposeByNameFixture,
  resolveAgentComposeVersionFixture,
} from "../../../../test-fixtures/agent-composes";
import { zeroComposesRoutes } from "../../zero-composes";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type ComposeContent = z.infer<typeof agentComposeApiContentSchema>;

interface AuthHeaders {
  readonly authorization?: string;
}

interface ComposeVersionQuery {
  readonly composeId: string;
  readonly version: string;
}

type CreateStatus = 200 | 201 | 400;
type ReadStatus = 200 | 404;
type ListStatus = 200 | 400 | 401 | 403;

/**
 * Compose version ids are sha256 hashes of the canonical (key-sorted) JSON
 * of the normalized compose content, so an ambiguous version prefix is
 * service-constructible: brute-force two agent descriptions whose normalized
 * contents hash to the same leading 8 hex characters and create both under
 * one compose name. The pair below was found by iterating `collide-<n>`
 * descriptions (matches at n = 51351 and n = 71922).
 */
export const AMBIGUOUS_COMPOSE_NAME = "bdd-ambiguous-version-agent";
export const AMBIGUOUS_VERSION_PREFIX = "1252758f";

function ambiguousComposeContent(description: string): ComposeContent {
  return {
    version: "1.0",
    agents: {
      [AMBIGUOUS_COMPOSE_NAME]: {
        framework: "claude-code",
        description,
      },
    },
  };
}

export const AMBIGUOUS_COMPOSE_CONTENTS: readonly [
  ComposeContent,
  ComposeContent,
] = [
  ambiguousComposeContent("collide-51351"),
  ambiguousComposeContent("collide-71922"),
];

export const AMBIGUOUS_VERSION_IDS: readonly [string, string] = [
  "1252758f4e94dedeb863d9ce8ee2451f093213719b432d61e5524c217700925a",
  "1252758f59ff4bb5829f658b6fe3d92dd68599997a6ebd4426ac1420ed8023ee",
];

function fixtureActor(actor: ApiTestUser): {
  readonly userId: string;
  readonly orgId: string;
} {
  if (!actor.orgId) {
    throw new Error("Compose fixtures require an org-scoped actor");
  }
  return { userId: actor.userId, orgId: actor.orgId };
}

export function createComposesBddApi(context: TestContext) {
  const routeMocks = createZeroRouteMocks(context);

  function authenticate(actor: ApiTestUser | null): AuthHeaders {
    if (actor === null) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  function zeroListClient() {
    return setupAppWithRoutes({ context, routes: zeroComposesRoutes })(
      zeroComposesListContract,
    );
  }

  return {
    async requestCreateCompose<TStatus extends CreateStatus>(
      actor: ApiTestUser,
      content: ComposeContent,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        createAgentComposeFixture({
          actor: fixtureActor(actor),
          content,
          signal: context.signal,
        }),
        statuses,
      );
    },

    async requestReadComposeById<TStatus extends ReadStatus>(
      actor: ApiTestUser,
      composeId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        readAgentComposeByIdFixture({
          actor: fixtureActor(actor),
          composeId,
        }),
        statuses,
      );
    },

    async requestReadComposeByName<TStatus extends ReadStatus>(
      actor: ApiTestUser,
      name: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        readAgentComposeByNameFixture({
          actor: fixtureActor(actor),
          name,
        }),
        statuses,
      );
    },

    async resolveComposeVersion(
      actor: ApiTestUser,
      query: ComposeVersionQuery,
    ): Promise<{ readonly versionId: string; readonly tag?: string }> {
      const response = await accept(
        resolveAgentComposeVersionFixture({
          actor: fixtureActor(actor),
          ...query,
        }),
        [200],
      );
      return response.body;
    },

    async requestResolveComposeVersion<TStatus extends ReadStatus | 400>(
      actor: ApiTestUser,
      query: ComposeVersionQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        resolveAgentComposeVersionFixture({
          actor: fixtureActor(actor),
          ...query,
        }),
        statuses,
      );
    },

    async requestListZeroComposes<TStatus extends ListStatus>(
      actor: ApiTestUser | null,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        zeroListClient().list({ headers: authenticate(actor), query: {} }),
        statuses,
      );
    },
  };
}
