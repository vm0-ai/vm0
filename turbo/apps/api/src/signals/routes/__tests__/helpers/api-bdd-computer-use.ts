import { randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { cronComputerUseScreenshotCleanupContract } from "@vm0/api-contracts/contracts/cron";
import {
  zeroComputerUseAuditEventsContract,
  zeroComputerUseCommandApprovalContract,
  zeroComputerUseCommandContract,
  zeroComputerUseHeartbeatContract,
  zeroComputerUseHostCommandsContract,
  zeroComputerUseHostsContract,
  zeroComputerUseWriteCommandContract,
  type ComputerUseAuditEventListResponse,
  type ComputerUseCommandCreateResponse,
  type ComputerUseCommandError,
  type ComputerUseCommandResponse,
  type ComputerUseCommandResult,
  type ComputerUseHostListResponse,
  type ComputerUseReadCommandKind,
  type ComputerUseWriteCommandKind,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { now } from "../../../../lib/time";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

interface RequiredAuthHeaders {
  readonly authorization: string;
}

/**
 * Computer-use routes accept either a Clerk session actor or a bearer token
 * (zero run tokens for command routes). `null` issues an unauthenticated
 * request.
 */
type ComputerUseAuth = ApiTestUser | { readonly bearer: string } | null;

interface ComputerUseHostStartOptions {
  readonly hostName?: string;
  readonly supportedCapabilities?: readonly string[];
}

interface ComputerUseReadCommandBody {
  readonly kind: ComputerUseReadCommandKind;
  readonly app?: string;
  readonly timeoutMs?: number;
}

interface ComputerUseWriteCommandBody {
  readonly kind: ComputerUseWriteCommandKind;
  readonly app: string;
  readonly timeoutMs?: number;
  readonly snapshotId?: string;
  readonly elementIndex?: number;
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: number;
}

type ComputerUseCompleteBody =
  | {
      readonly status: "succeeded";
      readonly result: ComputerUseCommandResult;
    }
  | {
      readonly status: "failed";
      readonly error: ComputerUseCommandError;
    };

interface RecordedComputerUseS3Put {
  readonly bucket: string;
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

interface ComputerUseS3Fake {
  readonly puts: readonly RecordedComputerUseS3Put[];
  readonly deletedKeys: readonly string[];
}

const DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES = [
  "apps.list",
  "app.state",
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
] as const;

const DEFAULT_WRITE_COMMAND_BODY = {
  kind: "app.open",
  app: "Safari",
  timeoutMs: 15_000,
} as const satisfies ComputerUseWriteCommandBody;

function hostHeaders(hostToken: string): RequiredAuthHeaders {
  return { authorization: `Bearer ${hostToken}` };
}

function hostTokenHeaders(hostToken: string | null): AuthHeaders {
  return hostToken === null ? {} : hostHeaders(hostToken);
}

function hostRuntimeBody(options: ComputerUseHostStartOptions = {}) {
  return {
    hostName: options.hostName ?? "Zero Desktop",
    appVersion: "0.1.0",
    osVersion: "macOS 15",
    supportedCapabilities: [
      ...(options.supportedCapabilities ??
        DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES),
    ],
    permissions: { accessibility: true, screenRecording: true },
  };
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
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

function objectBytes(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  return Buffer.from(typeof body === "string" ? body : "");
}

function bodyStream(buffer: Buffer): AsyncIterable<Uint8Array> {
  return (async function* stream(): AsyncIterable<Uint8Array> {
    yield new Uint8Array(buffer);
  })();
}

/**
 * Mint a zero run token directly, the same auth boundary production crosses
 * when zero-runs-create issues a token whose chat thread granted a
 * computer-use host (`generateZeroToken`). Precedent: `zeroCapabilityToken`
 * in api-bdd-github.ts. Returns the runId so audit events created by the
 * token's commands can be read back through the audit-events list API.
 */
export function zeroComputerUseToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
  readonly computerUseHostId?: string;
}): { readonly token: string; readonly runId: string } {
  const seconds = Math.floor(now() / 1000);
  const runId = `run_${randomUUID()}`;
  const token = signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId,
    capabilities: [...args.capabilities],
    ...(args.computerUseHostId
      ? { computerUseHostId: args.computerUseHostId }
      : {}),
    iat: seconds,
    exp: seconds + 3600,
  });
  return { token, runId };
}

export function createComputerUseBddApi(context: TestContext) {
  const mocks = createZeroRouteMocks(context);

  function authenticate(auth: ComputerUseAuth): AuthHeaders {
    if (auth === null) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    if ("bearer" in auth) {
      return { authorization: `Bearer ${auth.bearer}` };
    }
    mocks.clerk.session(auth.userId, auth.orgId, auth.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  function featureSwitchesClient() {
    return setupApp({ context })(zeroFeatureSwitchesContract);
  }

  function hostsClient() {
    return setupApp({ context })(zeroComputerUseHostsContract);
  }

  function heartbeatClient() {
    return setupApp({ context })(zeroComputerUseHeartbeatContract);
  }

  function commandClient() {
    return setupApp({ context })(zeroComputerUseCommandContract);
  }

  function writeCommandClient() {
    return setupApp({ context })(zeroComputerUseWriteCommandContract);
  }

  function approvalClient() {
    return setupApp({ context })(zeroComputerUseCommandApprovalContract);
  }

  function hostCommandsClient() {
    return setupApp({ context })(zeroComputerUseHostCommandsContract);
  }

  function auditEventsClient() {
    return setupApp({ context })(zeroComputerUseAuditEventsContract);
  }

  function cleanupCronClient() {
    return setupApp({ context })(cronComputerUseScreenshotCleanupContract);
  }

  return {
    /**
     * Stateful in-memory S3 fake for the screenshot offload, proxy, and
     * retention flows. PutObject stores bytes and records the put, GetObject
     * streams stored bytes back, DeleteObjects records and removes keys.
     * Installed on the vi mock, so the global afterEach mockReset uninstalls
     * it; install inside the test that needs it.
     */
    installComputerUseS3Fake(): ComputerUseS3Fake {
      const store = new Map<
        string,
        { readonly body: Buffer; readonly contentType: string }
      >();
      const puts: RecordedComputerUseS3Put[] = [];
      const deletedKeys: string[] = [];

      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const name = commandName(command);
        const input = commandInput(command);
        const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
        const key = typeof input.Key === "string" ? input.Key : "";

        if (name === "PutObjectCommand") {
          const body = objectBytes(input.Body);
          const contentType =
            typeof input.ContentType === "string" ? input.ContentType : "";
          store.set(`${bucket}/${key}`, { body, contentType });
          puts.push({ bucket, key, body, contentType });
          return Promise.resolve({});
        }
        if (name === "GetObjectCommand") {
          const stored = store.get(`${bucket}/${key}`);
          if (!stored) {
            return Promise.reject(
              new Error(`Computer-use S3 fake has no object ${bucket}/${key}`),
            );
          }
          return Promise.resolve({ Body: bodyStream(stored.body) });
        }
        if (name === "DeleteObjectsCommand") {
          for (const deletedKey of deleteObjectKeys(input)) {
            deletedKeys.push(deletedKey);
            store.delete(`${bucket}/${deletedKey}`);
          }
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      return { puts, deletedKeys };
    },

    async enableComputerUse(actor: ApiTestUser): Promise<void> {
      await accept(
        featureSwitchesClient().update({
          headers: authenticate(actor),
          body: { switches: { [FeatureSwitchKey.ComputerUse]: true } },
        }),
        [200],
      );
    },

    async startComputerUseHost(
      actor: ApiTestUser,
      options: ComputerUseHostStartOptions = {},
    ): Promise<{ readonly hostId: string; readonly hostToken: string }> {
      const response = await accept(
        hostsClient().start({
          headers: authenticate(actor),
          body: hostRuntimeBody(options),
        }),
        [200],
      );
      return response.body;
    },

    async requestStartComputerUseHost(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 409)[],
    ) {
      return await accept(
        hostsClient().start({
          headers: authenticate(actor),
          body: hostRuntimeBody(),
        }),
        statuses,
      );
    },

    async requestListComputerUseHosts(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        hostsClient().list({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async listComputerUseHosts(
      actor: ApiTestUser,
    ): Promise<ComputerUseHostListResponse> {
      const response = await accept(
        hostsClient().list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestDeleteComputerUseHost(
      actor: ApiTestUser | null,
      hostId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        hostsClient().delete({
          headers: authenticate(actor),
          params: { hostId },
        }),
        statuses,
      );
    },

    async deleteComputerUseHost(
      actor: ApiTestUser,
      hostId: string,
    ): Promise<void> {
      await accept(
        hostsClient().delete({
          headers: authenticate(actor),
          params: { hostId },
        }),
        [200],
      );
    },

    async heartbeatComputerUseHost(
      hostToken: string,
    ): Promise<{ readonly ok: true; readonly hostId: string }> {
      const response = await accept(
        heartbeatClient().heartbeat({
          headers: hostHeaders(hostToken),
          body: hostRuntimeBody(),
        }),
        [200],
      );
      return response.body;
    },

    async requestComputerUseHeartbeat(
      hostToken: string | null,
      statuses: readonly (200 | 401 | 409)[],
    ) {
      return await accept(
        heartbeatClient().heartbeat({
          headers: hostTokenHeaders(hostToken),
          body: hostRuntimeBody(),
        }),
        statuses,
      );
    },

    async stopComputerUseHost(
      hostToken: string,
    ): Promise<{ readonly ok: true; readonly hostId: string }> {
      const response = await accept(
        heartbeatClient().stop({
          headers: hostHeaders(hostToken),
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestStopComputerUseHost(
      hostToken: string | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        heartbeatClient().stop({
          headers: hostTokenHeaders(hostToken),
          body: {},
        }),
        statuses,
      );
    },

    async createComputerUseReadCommand(
      auth: ComputerUseAuth,
      body: ComputerUseReadCommandBody,
    ): Promise<ComputerUseCommandCreateResponse> {
      const response = await accept(
        commandClient().create({
          headers: authenticate(auth),
          body: { timeoutMs: 15_000, ...body },
        }),
        [200],
      );
      return response.body;
    },

    async requestCreateComputerUseReadCommand(
      auth: ComputerUseAuth,
      body: ComputerUseReadCommandBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      return await accept(
        commandClient().create({
          headers: authenticate(auth),
          body: { timeoutMs: 15_000, ...body },
        }),
        statuses,
      );
    },

    async createComputerUseWriteCommand(
      auth: ComputerUseAuth,
      body: ComputerUseWriteCommandBody = DEFAULT_WRITE_COMMAND_BODY,
    ): Promise<ComputerUseCommandCreateResponse> {
      const response = await accept(
        writeCommandClient().create({
          headers: authenticate(auth),
          body: { timeoutMs: 15_000, ...body },
        }),
        [200],
      );
      return response.body;
    },

    async requestCreateComputerUseWriteCommand(
      auth: ComputerUseAuth,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
      body: ComputerUseWriteCommandBody = DEFAULT_WRITE_COMMAND_BODY,
    ) {
      return await accept(
        writeCommandClient().create({
          headers: authenticate(auth),
          body: { timeoutMs: 15_000, ...body },
        }),
        statuses,
      );
    },

    async readComputerUseCommand(
      auth: ComputerUseAuth,
      commandId: string,
    ): Promise<ComputerUseCommandResponse> {
      const response = await accept(
        commandClient().get({
          headers: authenticate(auth),
          params: { commandId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadComputerUseCommand(
      auth: ComputerUseAuth,
      commandId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        commandClient().get({
          headers: authenticate(auth),
          params: { commandId },
        }),
        statuses,
      );
    },

    async requestComputerUseScreenshot(
      auth: ComputerUseAuth,
      commandId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        commandClient().getScreenshot({
          headers: authenticate(auth),
          params: { commandId },
        }),
        statuses,
      );
    },

    async downloadComputerUseScreenshot(
      auth: ComputerUseAuth,
      commandId: string,
    ): Promise<{
      readonly contentType: string | null;
      readonly bytes: Buffer;
    }> {
      const response = await accept(
        commandClient().getScreenshot({
          headers: authenticate(auth),
          params: { commandId },
        }),
        [200],
      );
      const body: unknown = response.body;
      if (!(body instanceof Blob)) {
        throw new Error("Expected a binary computer-use screenshot body");
      }
      return {
        contentType: response.headers.get("content-type"),
        bytes: Buffer.from(await body.arrayBuffer()),
      };
    },

    async decideComputerUseApproval(
      auth: ComputerUseAuth,
      commandId: string,
      body: {
        readonly decision: "approve" | "deny";
        readonly message?: string;
      },
      statuses: readonly (200 | 401 | 403 | 404 | 409)[],
    ) {
      return await accept(
        approvalClient().decide({
          headers: authenticate(auth),
          params: { commandId },
          body,
        }),
        statuses,
      );
    },

    async claimNextComputerUseCommand(hostToken: string): Promise<
      | { readonly status: "idle" }
      | {
          readonly status: "command";
          readonly command: ComputerUseCommandResponse;
        }
    > {
      const response = await accept(
        hostCommandsClient().next({
          headers: hostHeaders(hostToken),
          body: {
            supportedCapabilities: [
              ...DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES,
            ],
          },
        }),
        [200],
      );
      return response.body;
    },

    async requestClaimNextComputerUseCommand(
      hostToken: string | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        hostCommandsClient().next({
          headers: hostTokenHeaders(hostToken),
          body: {
            supportedCapabilities: [
              ...DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES,
            ],
          },
        }),
        statuses,
      );
    },

    async completeComputerUseCommand(
      hostToken: string,
      commandId: string,
    ): Promise<void> {
      await accept(
        hostCommandsClient().complete({
          headers: hostHeaders(hostToken),
          params: { commandId },
          body: {
            status: "succeeded",
            result: { app: "Safari", opened: true },
          },
        }),
        [200],
      );
    },

    async completeComputerUseCommandWith(
      hostToken: string,
      commandId: string,
      body: ComputerUseCompleteBody,
    ): Promise<void> {
      await accept(
        hostCommandsClient().complete({
          headers: hostHeaders(hostToken),
          params: { commandId },
          body,
        }),
        [200],
      );
    },

    async requestCompleteComputerUseCommand(
      hostToken: string | null,
      commandId: string,
      body: ComputerUseCompleteBody,
      statuses: readonly (200 | 400 | 401 | 404 | 409)[],
    ) {
      return await accept(
        hostCommandsClient().complete({
          headers: hostTokenHeaders(hostToken),
          params: { commandId },
          body,
        }),
        statuses,
      );
    },

    async requestListComputerUseAuditEvents(
      actor: ApiTestUser | null,
      query: {
        readonly commandId?: string;
        readonly hostId?: string;
        readonly runId?: string;
        readonly limit?: number;
      },
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        auditEventsClient().list({
          headers: authenticate(actor),
          query,
        }),
        statuses,
      );
    },

    async listComputerUseAuditEvents(
      actor: ApiTestUser,
      query: {
        readonly commandId?: string;
        readonly hostId?: string;
        readonly runId?: string;
        readonly limit?: number;
      } = {},
    ): Promise<ComputerUseAuditEventListResponse> {
      const response = await accept(
        auditEventsClient().list({
          headers: authenticate(actor),
          query,
        }),
        [200],
      );
      return response.body;
    },

    // Kept out of any shared safe-cron helper for the same shared-database
    // reason as reconcileBillingCron in api-bdd-runs-schedules.ts: the
    // screenshot-cleanup sweep is global (no org filter) and tombstones every
    // screenshot row older than the 30-day retention window. Only
    // computer-use.bdd.test.ts may invoke this cron, and only that file may
    // create screenshot rows older than the retention window; sweep counts
    // are asserted as `>=` on the first run because earlier aborted local
    // runs can leave old rows behind.
    async runComputerUseScreenshotCleanupCron(
      auth: "valid" | "invalid" | "missing",
    ) {
      const headers =
        auth === "missing"
          ? {}
          : {
              authorization:
                auth === "valid"
                  ? "Bearer test-cron-secret"
                  : "Bearer wrong-secret",
            };
      return await accept(cleanupCronClient().cleanup({ headers }), [200, 401]);
    },
  };
}
