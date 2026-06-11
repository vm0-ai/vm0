import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  agentComposeApiContentSchema,
  composesByIdContract,
  composesInstructionsContract,
  composesListContract,
  composesMainContract,
  composesMetadataContract,
  composesVersionsContract,
} from "@vm0/api-contracts/contracts/composes";
import {
  zeroComposesByIdContract,
  zeroComposesListContract,
  zeroComposesMainContract,
  zeroComposesMetadataContract,
} from "@vm0/api-contracts/contracts/zero-composes";
import type { z } from "zod";

import { createApp } from "../../../../app-factory";
import { now } from "../../../../lib/time";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../../auth/tokens";
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

interface ComposeMetadataBody {
  readonly displayName?: string;
  readonly description?: string;
  readonly sound?: string;
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

/**
 * Zero-scope token carrying `agent:delete`, proving compose deletion is
 * refused even for capability-bearing zero tokens (web-compatible 403).
 */
export function zeroComposeDeleteToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: ["agent:delete"],
    iat: seconds,
    exp: seconds + 3600,
  });
}

const TAR_BLOCK_SIZE = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

// Private copy of the single-file tar-gz construction in zero-skills.ts
// (not exported there; ~20 lines). extractFileFromTarGz only needs the
// filename, size, and payload from a USTAR-compatible header.
function createTarEntry(filename: string, content: Buffer): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(filename, 0, 100, "utf8");
  header.write("0000644\0", 100); // mode
  header.write("0000000\0", 108); // uid
  header.write("0000000\0", 116); // gid
  header.write(octal(content.length, 12), 124); // size
  header.write(octal(0, 12), 136); // mtime
  // Checksum placeholder: 8 spaces required so the checksum sum is correct.
  header.write("        ", 148);
  header.write("0", 156); // type flag (regular file)

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  // Final checksum: 6 octal digits, NUL, space.
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);

  const padding = content.length % TAR_BLOCK_SIZE;
  const dataBlocks =
    padding === 0
      ? content
      : Buffer.concat([content, Buffer.alloc(TAR_BLOCK_SIZE - padding)]);

  return Buffer.concat([header, dataBlocks]);
}

function createSingleFileTarGz(filename: string, content: Buffer): Buffer {
  const eofBlocks = Buffer.alloc(TAR_BLOCK_SIZE * 2);
  return gzipSync(
    Buffer.concat([createTarEntry(filename, content), eofBlocks]),
  );
}

function asyncIterableOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
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

function commandKey(command: unknown): string {
  const key = commandInput(command).Key;
  return typeof key === "string" ? key : "";
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

interface ComposeInstructionsDownloadArgs {
  readonly storageName: string;
  readonly filename: string;
  readonly manifestPath?: string;
  readonly content: string;
}

/**
 * S3 download boundary for storage-backed compose instructions. The storage
 * version s3Key is server-generated (`<orgId>/volume/<storageName>/<hash>`),
 * so keys are matched by storage-name inclusion plus suffix instead of
 * reading mock call state. Non-matching keys resolve `{}` so storage-commit
 * head checks keep passing. Same construction as `mockInstructionsContent`
 * in zero-skills.ts.
 */
export function mockComposeInstructionsDownloads(
  context: TestContext,
  args: ComposeInstructionsDownloadArgs,
): void {
  const contentBuffer = Buffer.from(args.content, "utf8");
  const path = args.manifestPath ?? args.filename;
  const archive = createSingleFileTarGz(path, contentBuffer);

  const manifest = {
    version: "bdd-version",
    createdAt: new Date(0).toISOString(),
    files: [
      { path, hash: "bdd-hash-instructions", size: contentBuffer.length },
    ],
    totalSize: contentBuffer.length,
    fileCount: 1,
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");

  context.mocks.s3.send.mockImplementation((cmd: unknown): Promise<unknown> => {
    const key = commandKey(cmd);
    if (!key.includes(args.storageName)) {
      return Promise.resolve({});
    }
    if (key.endsWith("/manifest.json")) {
      return Promise.resolve({ Body: asyncIterableOf(manifestBuffer) });
    }
    if (key.endsWith("/archive.tar.gz")) {
      return Promise.resolve({ Body: asyncIterableOf(archive) });
    }
    return Promise.resolve({});
  });
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
    return setupApp({ context })(composesMainContract);
  }

  function byIdClient() {
    return setupApp({ context })(composesByIdContract);
  }

  function listClient() {
    return setupApp({ context })(composesListContract);
  }

  function versionsClient() {
    return setupApp({ context })(composesVersionsContract);
  }

  function metadataClient() {
    return setupApp({ context })(composesMetadataContract);
  }

  function instructionsClient() {
    return setupApp({ context })(composesInstructionsContract);
  }

  function zeroMainClient() {
    return setupApp({ context })(zeroComposesMainContract);
  }

  function zeroByIdClient() {
    return setupApp({ context })(zeroComposesByIdContract);
  }

  function zeroListClient() {
    return setupApp({ context })(zeroComposesListContract);
  }

  function zeroMetadataClient() {
    return setupApp({ context })(zeroComposesMetadataContract);
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
     * Raw HTTP request for contract-invalid payloads the typed ts-rest
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
      const response = await createApp({ signal: context.signal }).request(
        request.path,
        {
          method: request.method,
          headers,
          ...(request.jsonBody === undefined
            ? {}
            : { body: JSON.stringify(request.jsonBody) }),
        },
      );
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

    async requestListComposes<TStatus extends ListStatus>(
      auth: ComposeAuth,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        listClient().list({ headers: authenticate(auth), query: {} }),
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

    async readComposeInstructions(
      auth: ComposeAuth,
      composeId: string,
    ): Promise<{
      readonly content: string | null;
      readonly filename: string | null;
    }> {
      const response = await accept(
        instructionsClient().getInstructions({
          headers: authenticate(auth),
          params: { id: composeId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadComposeInstructions<TStatus extends ReadStatus>(
      auth: ComposeAuth,
      composeId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        instructionsClient().getInstructions({
          headers: authenticate(auth),
          params: { id: composeId },
        }),
        statuses,
      );
    },

    async requestUpdateComposeMetadata<TStatus extends ReadStatus>(
      auth: ComposeAuth,
      composeId: string,
      body: ComposeMetadataBody,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        metadataClient().updateMetadata({
          headers: authenticate(auth),
          params: { id: composeId },
          body,
        }),
        statuses,
      );
    },

    async requestDeleteCompose<TStatus extends DeleteStatus>(
      auth: ComposeAuth,
      composeId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        byIdClient().delete({
          headers: authenticate(auth),
          params: { id: composeId },
        }),
        statuses,
      );
    },

    async requestReadZeroComposeByName<TStatus extends ReadStatus>(
      auth: ComposeAuth,
      name: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        zeroMainClient().getByName({
          headers: authenticate(auth),
          query: { name },
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
