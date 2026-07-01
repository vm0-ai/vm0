import { randomUUID } from "node:crypto";

import {
  agentComposeApiContentSchema,
  composesByIdContract,
  composesMainContract,
  composesVersionsContract,
} from "@vm0/api-contracts/contracts/composes";
import {
  zeroComposesByIdContract,
  zeroComposesListContract,
  zeroComposesMetadataContract,
} from "@vm0/api-contracts/contracts/zero-composes";
import type { z } from "zod";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { now } from "../../../../lib/time";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import { agentComposesByIdRoutes } from "../../agent-composes-id";
import { agentComposesReadRoutes } from "../../agent-composes-read";
import { agentComposesRoutes } from "../../agent-composes";
import { zeroComposesRoutes } from "../../zero-composes";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type ComposeContent = z.infer<typeof agentComposeApiContentSchema>;

/**
 * Compose routes accept Clerk session actors and helper-minted sandbox or
 * zero bearer tokens; `null` issues an unauthenticated request. Same shape
 * as `ComputerUseAuth` in api-bdd-computer-use.ts.
 */
type ComposeAuth = ApiTestUser | { readonly bearer: string } | null;

interface AuthHeaders {
  readonly authorization?: string;
}

interface ZeroComposeMetadataBody {
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly sound?: string | null;
}

interface ComposeVersionQuery {
  readonly composeId: string;
  readonly version: string;
}

interface RawComposeRequest {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly jsonBody?: unknown;
}

interface SweepObject {
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
}

type CreateStatus = 200 | 201 | 400 | 401 | 403;
type ReadStatus = 200 | 400 | 401 | 403 | 404;
type ListStatus = 200 | 400 | 401 | 403;
type DeleteStatus = 204 | 401 | 403 | 404 | 409;
type ZeroMetadataStatus = 200 | 401 | 404;

const composeRoutes = [
  ...agentComposesRoutes,
  ...agentComposesReadRoutes,
  ...agentComposesByIdRoutes,
  ...zeroComposesRoutes,
] as const;

/**
 * Compose version ids are sha256 hashes of the canonical (key-sorted) JSON
 * of the normalized compose content, so an ambiguous version prefix is
 * API-constructible: brute-force two agent descriptions whose normalized
 * contents hash to the same leading 8 hex characters and create both under
 * one compose name. The pair below was found by iterating `collide-<n>`
 * descriptions (matches at n = 51351 and n = 71922). The exact-hash asserts
 * in composes.bdd.test.ts guard canonicalization drift in
 * `computeComposeVersionId` — if they fail, recompute the pair.
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

/**
 * Mint a sandbox run token directly — the same auth boundary production
 * crosses when a runner claim hands the sandbox its token. Precedent:
 * `zeroComputerUseToken` in api-bdd-computer-use.ts and `zeroCapabilityToken`
 * in api-bdd-github.ts.
 */
export function sandboxComposeToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 3600,
  });
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

function deleteObjectKeys(input: Record<string, unknown>): string[] {
  const request = input.Delete;
  if (
    typeof request !== "object" ||
    request === null ||
    !("Objects" in request) ||
    !Array.isArray(request.Objects)
  ) {
    return [];
  }
  const keys: string[] = [];
  for (const object of request.Objects) {
    if (
      typeof object === "object" &&
      object !== null &&
      "Key" in object &&
      typeof object.Key === "string"
    ) {
      keys.push(object.Key);
    }
  }
  return keys;
}

export function createComposesBddApi(context: TestContext) {
  const routeMocks = createZeroRouteMocks(context);

  function authenticate(auth: ComposeAuth): AuthHeaders {
    if (auth === null) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    if ("bearer" in auth) {
      return { authorization: `Bearer ${auth.bearer}` };
    }
    routeMocks.clerk.session(auth.userId, auth.orgId, auth.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  function mainClient() {
    return setupAppWithRoutes({ context, routes: composeRoutes })(
      composesMainContract,
    );
  }

  function byIdClient() {
    return setupAppWithRoutes({ context, routes: composeRoutes })(
      composesByIdContract,
    );
  }

  function versionsClient() {
    return setupAppWithRoutes({ context, routes: composeRoutes })(
      composesVersionsContract,
    );
  }

  function zeroByIdClient() {
    return setupAppWithRoutes({ context, routes: composeRoutes })(
      zeroComposesByIdContract,
    );
  }

  function zeroListClient() {
    return setupAppWithRoutes({ context, routes: composeRoutes })(
      zeroComposesListContract,
    );
  }

  function zeroMetadataClient() {
    return setupAppWithRoutes({ context, routes: composeRoutes })(
      zeroComposesMetadataContract,
    );
  }

  return {
    /**
     * Arms the S3 list-objects boundary so the compose-delete volume sweep
     * sees existing instruction objects (legacy pattern:
     * agent-composes-delete.test.ts).
     */
    mockStorageSweepObjects(objects: readonly SweepObject[]): void {
      routeMocks.s3.listObjects(objects);
    },

    /** Keys passed to S3 DeleteObjects across all calls — sweep evidence. */
    s3DeletedObjectKeys(): readonly string[] {
      return context.mocks.s3.send.mock.calls.flatMap(([command]) => {
        return deleteObjectKeys(commandInput(command));
      });
    },

    /**
     * Raw HTTP request for contract-invalid payloads the typed contract
     * client cannot express (array agents, unsupported framework, numeric
     * metadata fields, malformed uuid paths, missing query params, short
     * version specifiers) and for reading stored compose content without
     * response-schema stripping.
     */
    async rawRequest(
      auth: ComposeAuth,
      request: RawComposeRequest,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const authHeaders = authenticate(auth);
      const headers: Record<string, string> = {
        ...(authHeaders.authorization
          ? { authorization: authHeaders.authorization }
          : {}),
        ...(request.jsonBody === undefined
          ? {}
          : { "content-type": "application/json" }),
      };
      const response = await createAppWithRoutes({
        signal: context.signal,
        routes: composeRoutes,
      }).request(request.path, {
        method: request.method,
        headers,
        ...(request.jsonBody === undefined
          ? {}
          : { body: JSON.stringify(request.jsonBody) }),
      });
      return { status: response.status, body: await response.json() };
    },

    async requestCreateCompose<TStatus extends CreateStatus>(
      auth: ComposeAuth,
      content: ComposeContent,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        mainClient().create({
          headers: authenticate(auth),
          body: { content },
        }),
        statuses,
      );
    },

    async requestReadComposeById<TStatus extends ReadStatus>(
      auth: ComposeAuth,
      composeId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        byIdClient().getById({
          headers: authenticate(auth),
          params: { id: composeId },
        }),
        statuses,
      );
    },

    async requestReadComposeByName<TStatus extends ReadStatus>(
      auth: ComposeAuth,
      name: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        mainClient().getByName({
          headers: authenticate(auth),
          query: { name },
        }),
        statuses,
      );
    },

    async resolveComposeVersion(
      auth: ComposeAuth,
      query: ComposeVersionQuery,
    ): Promise<{ readonly versionId: string; readonly tag?: string }> {
      const response = await accept(
        versionsClient().resolveVersion({
          headers: authenticate(auth),
          query,
        }),
        [200],
      );
      return response.body;
    },

    async requestResolveComposeVersion<TStatus extends ReadStatus>(
      auth: ComposeAuth,
      query: ComposeVersionQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        versionsClient().resolveVersion({
          headers: authenticate(auth),
          query,
        }),
        statuses,
      );
    },

    async requestListZeroComposes<TStatus extends ListStatus>(
      auth: ComposeAuth,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        zeroListClient().list({ headers: authenticate(auth), query: {} }),
        statuses,
      );
    },

    async requestUpdateZeroComposeMetadata<TStatus extends ZeroMetadataStatus>(
      auth: ComposeAuth,
      composeId: string,
      body: ZeroComposeMetadataBody,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        zeroMetadataClient().update({
          headers: authenticate(auth),
          params: { id: composeId },
          body,
        }),
        statuses,
      );
    },

    async requestDeleteZeroCompose<TStatus extends DeleteStatus>(
      auth: ComposeAuth,
      composeId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        zeroByIdClient().delete({
          headers: authenticate(auth),
          params: { id: composeId },
        }),
        statuses,
      );
    },
  };
}
