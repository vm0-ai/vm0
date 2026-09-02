import { authContract } from "@okouai/api-contracts/contracts/auth";
import { expect, vi } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import type { SharedDatabasePortLike } from "../bridge.ts";
import type { SharedDatabaseIdentity } from "../data-key.ts";
import {
  forceRefreshWorkerToken$,
  getWorkerToken$,
  registerConnection$,
  setWorkerToken$,
  type WorkerBroadcastMessage,
} from "../worker-context.ts";
import { createSharedDatabaseContractClientFactory } from "../worker-client.ts";
import { createSharedDatabaseCredentialStore } from "../worker-signals.ts";

const context = testContext();
const WORKER_APP_VERSION = "auth-recovery-worker-version";

class CollectingPort implements SharedDatabasePortLike {
  readonly messages: WorkerBroadcastMessage[] = [];

  postMessage(value: unknown): void {
    this.messages.push(value as WorkerBroadcastMessage);
  }

  start(): void {}

  close(): void {}

  addEventListener(
    _type: "message",
    _listener: (event: MessageEvent<unknown>) => void,
  ): void {}

  removeEventListener(
    _type: "message",
    _listener: (event: MessageEvent<unknown>) => void,
  ): void {}
}

function identity(): SharedDatabaseIdentity {
  return {
    userId: `auth-recovery-user-${context.resourceId}`,
    orgId: `auth-recovery-org-${context.resourceId}`,
    token: "initial-token",
  };
}

function createAuthedClient(options: {
  readonly forceRefreshToken: (signal: AbortSignal) => Promise<string | null>;
}) {
  return createSharedDatabaseContractClientFactory(WORKER_APP_VERSION)(
    authContract,
    location.origin,
    {
      getToken: () => {
        return Promise.resolve("initial-token");
      },
      forceRefreshToken: options.forceRefreshToken,
    },
    context.signal,
    () => {
      return undefined;
    },
  );
}

function mockExpiredInitialToken(): string[] {
  const authorizationHeaders: string[] = [];
  context.mocks.api(authContract.me, ({ request, respond }) => {
    const authorization = request.headers.get("authorization") ?? "";
    authorizationHeaders.push(authorization);
    if (authorization === "Bearer initial-token") {
      return respond(401, {
        error: { code: "UNAUTHORIZED", message: "Session expired" },
      });
    }
    return respond(200, {
      userId: identity().userId,
      email: "auth-recovery@example.com",
      orgId: identity().orgId,
    });
  });
  return authorizationHeaders;
}

test("Refresh an expired session while loading chat data", async () => {
  const authorizationHeaders = mockExpiredInitialToken();
  let refreshes = 0;
  const client = createAuthedClient({
    forceRefreshToken: () => {
      refreshes += 1;
      return Promise.resolve("replacement-token");
    },
  });

  await expect(client.me({ headers: {} })).resolves.toMatchObject({
    status: 200,
  });

  expect(refreshes).toBe(1);
  expect(authorizationHeaders).toStrictEqual([
    "Bearer initial-token",
    "Bearer replacement-token",
  ]);
});

test("Coordinate authentication recovery across tabs", async () => {
  const store = createSharedDatabaseCredentialStore(
    {
      appVersion: WORKER_APP_VERSION,
      identity: identity(),
      apiBaseUrl: location.origin,
      vercelProtectionBypass: undefined,
    },
    context.signal,
  );
  const firstController = createChildAbortController(context.signal);
  const secondController = createChildAbortController(context.signal);
  const firstPort = new CollectingPort();
  const secondPort = new CollectingPort();
  const firstSignal = store.set(
    registerConnection$,
    "first-tab",
    firstController,
    firstPort,
    firstController.signal,
  );
  const secondSignal = store.set(
    registerConnection$,
    "second-tab",
    secondController,
    secondPort,
    secondController.signal,
  );

  const firstRecovery = store.set(forceRefreshWorkerToken$, firstSignal);
  const secondRecovery = store.set(forceRefreshWorkerToken$, secondSignal);

  await vi.waitFor(() => {
    expect(firstPort.messages).toHaveLength(1);
    expect(secondPort.messages).toHaveLength(1);
  });
  const request = firstPort.messages[0];
  expect(request).toStrictEqual(secondPort.messages[0]);
  if (request?.type !== "authentication-required") {
    throw new Error("Authentication recovery was not requested");
  }

  store.set(
    setWorkerToken$,
    "first-tab",
    request.recoveryId,
    "replacement-token",
  );

  await expect(
    Promise.all([firstRecovery, secondRecovery]),
  ).resolves.toStrictEqual(["replacement-token", "replacement-token"]);
  await expect(store.set(getWorkerToken$, firstSignal)).resolves.toBe(
    "replacement-token",
  );
});

test("Recover after a token refresh temporarily fails", async () => {
  const authorizationHeaders = mockExpiredInitialToken();
  const refreshError = new Error("Clerk token refresh failed");
  let refreshes = 0;
  const client = createAuthedClient({
    forceRefreshToken: () => {
      refreshes += 1;
      return refreshes === 1
        ? Promise.reject(refreshError)
        : Promise.resolve("replacement-token");
    },
  });

  await expect(client.me({ headers: {} })).rejects.toBe(refreshError);
  await expect(client.me({ headers: {} })).resolves.toMatchObject({
    status: 200,
  });

  expect(refreshes).toBe(2);
  expect(authorizationHeaders).toStrictEqual([
    "Bearer initial-token",
    "Bearer initial-token",
    "Bearer replacement-token",
  ]);
});
