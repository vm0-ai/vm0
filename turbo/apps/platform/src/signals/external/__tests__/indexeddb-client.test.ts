// @vitest-environment-options {"url":"https://app.vm0.ai/"}

import { openDB, type DBSchema } from "idb";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { beforeEach, expect, test, vi } from "vitest";

import { CHAT_EVENT_SCHEMA_VERSION_HEADERS } from "../../../shared-database/chat-event-schema-version.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../__tests__/test-helpers.ts";
import { createAuthedContractClient } from "../../api-client-base.ts";
import {
  deleteIntroVideoDraft,
  readIntroVideoDraft,
  saveIntroVideoDraft,
} from "../intro-video-draft-store.ts";
import { runIndexedDbTransaction } from "../indexeddb-client.ts";

const axiomTelemetry = vi.hoisted(() => {
  return {
    ingest:
      vi.fn<
        (dataset: string, events: readonly Record<string, unknown>[]) => void
      >(),
  };
});

vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest(
        dataset: string,
        events: readonly Record<string, unknown>[],
      ): void {
        axiomTelemetry.ingest(dataset, events);
      }
    },
  };
});

interface TelemetryTestDatabase extends DBSchema {
  readonly records: {
    readonly key: string;
    readonly value: { readonly secret: string };
  };
}

const context = testContext();

beforeEach(() => {
  vi.stubEnv("VITE_AXIOM_CLIENT_TELEMETRY_TOKEN", "xaat-test-ingest-token");
  context.signal.addEventListener(
    "abort",
    () => {
      vi.unstubAllEnvs();
    },
    { once: true },
  );
  axiomTelemetry.ingest.mockClear();
});

async function openTelemetryTestDatabase() {
  return await openDB<TelemetryTestDatabase>(crypto.randomUUID(), 1, {
    upgrade(database) {
      database.createObjectStore("records");
    },
  });
}

async function capturedEvent(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => {
    expect(axiomTelemetry.ingest).toHaveBeenCalledOnce();
  });
  const [dataset, events] = axiomTelemetry.ingest.mock.calls[0]!;
  expect(dataset).toBe("vm0-client-telemetry-prod");
  expect(events).toHaveLength(1);
  return events[0]!;
}

test("Reports one parameter-free event for a physical IndexedDB transaction", async () => {
  const database = await openTelemetryTestDatabase();
  const sensitiveKey = `private-key-${crypto.randomUUID()}`;
  const sensitiveValue = `private-value-${crypto.randomUUID()}`;

  try {
    vi.stubGlobal("window", undefined);
    await expect(
      runIndexedDbTransaction(
        {
          database: "chat",
          template: "records.put+get",
        },
        () => {
          return database.transaction("records", "readwrite");
        },
        async (transaction, trackRequest) => {
          await trackRequest(
            transaction.store.put({ secret: sensitiveValue }, sensitiveKey),
          );
          return await trackRequest(transaction.store.get(sensitiveKey));
        },
      ),
    ).resolves.toStrictEqual({ secret: sensitiveValue });
  } finally {
    database.close();
  }

  const event = await capturedEvent();
  expect(event).toMatchObject({
    "attributes.custom": {
      "db.namespace": "chat",
      "db.system": "indexeddb",
      "okou.client.outcome": "success",
      "okou.client.runtime": "shared_worker",
      "okou.db.request.count": 2,
      "okou.db.transaction.mode": "readwrite",
    },
    kind: "client",
    name: "records.put+get",
    "resource.deployment.environment.name": "production",
    "scope.name": "okou-app/indexeddb",
    "service.name": "Okou-app",
    "service.version": "0.540.0",
    "status.code": "OK",
  });
  expect(event.duration).toStrictEqual(expect.any(Number));
  expect(event).not.toHaveProperty("duration_ms");
  expect(event).not.toHaveProperty("event_name");
  expect(event).not.toHaveProperty("resource.custom");
  expect(event).not.toHaveProperty("template");
  expect(JSON.stringify(event)).not.toContain(sensitiveKey);
  expect(JSON.stringify(event)).not.toContain(sensitiveValue);
});

test("Reports an aborted IndexedDB transaction without hiding its error", async () => {
  const database = await openTelemetryTestDatabase();

  try {
    await expect(
      runIndexedDbTransaction(
        {
          database: "intro_video_drafts",
          template: "records.put",
        },
        () => {
          return database.transaction("records", "readwrite");
        },
        async (transaction, trackRequest) => {
          const request = trackRequest(
            transaction.store.put({ secret: "draft" }, "latest"),
          );
          transaction.abort();
          await request;
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    database.close();
  }

  const event = await capturedEvent();
  expect(event).toMatchObject({
    "attributes.custom": {
      "db.namespace": "intro_video_drafts",
      "okou.client.outcome": "aborted",
      "okou.db.request.count": 1,
      "okou.db.transaction.mode": "readwrite",
    },
    name: "records.put",
  });
  expect(event).not.toHaveProperty("status.code");
});

test("Routes every intro video draft operation through one transaction event", async () => {
  const draft = {
    blob: new Blob(["private draft"]),
    contentType: "video/mp4",
    createdAt: 1_777_777_777_777,
    durationSeconds: 12,
    kind: "video" as const,
    name: "private-draft.mp4",
  };

  await saveIntroVideoDraft(draft);
  const restoredDraft = await readIntroVideoDraft();
  expect(restoredDraft).toMatchObject({
    contentType: draft.contentType,
    createdAt: draft.createdAt,
    durationSeconds: draft.durationSeconds,
    kind: draft.kind,
    name: draft.name,
  });
  expect(restoredDraft?.blob).toBeDefined();
  await deleteIntroVideoDraft();
  await expect(readIntroVideoDraft()).resolves.toBeNull();

  await vi.waitFor(() => {
    expect(axiomTelemetry.ingest).toHaveBeenCalledTimes(4);
  });
  expect(
    axiomTelemetry.ingest.mock.calls.map(([, events]) => {
      return events[0];
    }),
  ).toMatchObject([
    {
      "attributes.custom": {
        "db.namespace": "intro_video_drafts",
        "okou.db.request.count": 1,
      },
      name: "intro_video_drafts.put",
    },
    {
      "attributes.custom": {
        "db.namespace": "intro_video_drafts",
        "okou.db.request.count": 1,
      },
      name: "intro_video_drafts.get",
    },
    {
      "attributes.custom": {
        "db.namespace": "intro_video_drafts",
        "okou.db.request.count": 1,
      },
      name: "intro_video_drafts.delete",
    },
    {
      "attributes.custom": {
        "db.namespace": "intro_video_drafts",
        "okou.db.request.count": 1,
      },
      name: "intro_video_drafts.get",
    },
  ]);
});

test("Reports typed API requests with route templates and no parameters", async () => {
  const sensitiveThreadId = crypto.randomUUID();
  const sensitiveToken = `private-token-${crypto.randomUUID()}`;
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(200, chatEventRowsResponse([], query));
  });
  const client = createAuthedContractClient(chatThreadEventsContract, {
    baseUrl: location.origin,
    clientVersion: "test-version",
    getRootSignal: () => {
      return context.signal;
    },
    getToken: () => {
      return Promise.resolve(sensitiveToken);
    },
    getVercelProtectionBypass: () => {
      return undefined;
    },
  });

  await expect(
    client.rows({
      headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
      params: { threadId: sensitiveThreadId },
      query: { limit: 50, sinceSeqId: 0 },
    }),
  ).resolves.toMatchObject({ status: 200 });

  const event = await capturedEvent();
  expect(event).toMatchObject({
    "attributes.custom": {
      "okou.client.outcome": "success",
      "okou.client.runtime": "window",
    },
    "attributes.http.request.method": "GET",
    "attributes.http.response.status_code": 200,
    "attributes.http.route": "/api/chat-threads/:threadId/event-rows",
    kind: "client",
    name: "GET /api/chat-threads/:threadId/event-rows",
    "resource.deployment.environment.name": "production",
    "scope.name": "okou-app/http",
    "service.name": "Okou-app",
    "service.version": "0.540.0",
    "status.code": "OK",
  });
  expect(JSON.stringify(event)).not.toContain(sensitiveThreadId);
  expect(JSON.stringify(event)).not.toContain(sensitiveToken);
  expect(JSON.stringify(event)).not.toContain("sinceSeqId");
});

test("Reports API server failures as RED errors", async () => {
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(500, {
      error: { code: "internal_error", message: "Internal server error" },
    });
  });
  const client = createAuthedContractClient(featureSwitchesContract, {
    baseUrl: location.origin,
    clientVersion: "test-version",
    getRootSignal: () => {
      return context.signal;
    },
    getToken: () => {
      return Promise.resolve("test-token");
    },
    getVercelProtectionBypass: () => {
      return undefined;
    },
  });

  await expect(client.get()).resolves.toMatchObject({ status: 500 });

  await expect(capturedEvent()).resolves.toMatchObject({
    "attributes.custom": {
      "okou.client.outcome": "error",
    },
    "attributes.http.response.status_code": 500,
    name: "GET /api/feature-switches",
    "scope.name": "okou-app/http",
    "status.code": "ERROR",
  });
});
