// @vitest-environment-options {"url":"https://app.vm0.ai/"}

import { openDB, type DBSchema } from "idb";
import { beforeEach, expect, test, vi } from "vitest";

import { testContext } from "../../__tests__/test-helpers.ts";
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
    app_version: "0.540.0",
    database: "chat",
    environment: "production",
    event_name: "indexeddb.transaction",
    outcome: "success",
    public_brand: "vm0",
    request_count: 2,
    source: "shared_worker",
    template: "records.put+get",
    transaction_mode: "readwrite",
  });
  expect(event.duration_ms).toStrictEqual(expect.any(Number));
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

  await expect(capturedEvent()).resolves.toMatchObject({
    database: "intro_video_drafts",
    event_name: "indexeddb.transaction",
    outcome: "aborted",
    request_count: 1,
    template: "records.put",
    transaction_mode: "readwrite",
  });
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
      database: "intro_video_drafts",
      request_count: 1,
      template: "intro_video_drafts.put",
    },
    {
      database: "intro_video_drafts",
      request_count: 1,
      template: "intro_video_drafts.get",
    },
    {
      database: "intro_video_drafts",
      request_count: 1,
      template: "intro_video_drafts.delete",
    },
    {
      database: "intro_video_drafts",
      request_count: 1,
      template: "intro_video_drafts.get",
    },
  ]);
});
