import { screen, waitFor } from "@testing-library/react";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { afterAll, beforeEach, expect, test, vi } from "vitest";

import { setupPage, startPage } from "../../__tests__/page-helper.ts";
import {
  APP_FIRST_SKELETON_PAINT_EVENT,
  BOOTSTRAP_PHASE_TIMING_EVENT,
  captureFirstSkeletonPaint,
  initPostHog,
} from "../../lib/posthog.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { testContext } from "./test-helpers.ts";

const POSTHOG_KEY = "phc_startup_diagnostics_test";
const THREAD_ID = "b0000000-0000-4000-a000-000000000901";

const { apiOriginMarker } = vi.hoisted(() => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_startup_diagnostics_test");
  window.location.href = "https://app.vm0.ai/";
  const apiOriginMarker = document.createElement("meta");
  apiOriginMarker.name = "vm0-api-origin";
  apiOriginMarker.content = "https://api.vm0.ai";
  document.head.append(apiOriginMarker);
  return { apiOriginMarker };
});

const context = testContext();

beforeEach(() => {
  context.mocks.posthog();
  const moduleReadyAt = performance.now();
  window.__appBootstrapStart = moduleReadyAt - 20;
  window.__appBootstrapModuleReady = moduleReadyAt - 10;
  context.signal.addEventListener(
    "abort",
    () => {
      delete window.__appBootstrapStart;
      delete window.__appBootstrapModuleReady;
    },
    { once: true },
  );
});

afterAll(() => {
  apiOriginMarker.remove();
});

function capturedEvents(eventName: string): Record<string, unknown>[] {
  return context.mocks.posthog().events.flatMap(({ name, properties }) => {
    return name === eventName ? [properties ?? {}] : [];
  });
}

function mockMissingConversation(): void {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
}

async function waitForErrorPage(): Promise<void> {
  await screen.findByText("Oops! Something went sideways");
}

test("An aborted route does not claim thread timing", async () => {
  const snapshotRequested = context.mocks.deferred<void>();
  const releaseSnapshot = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    snapshotRequested.resolve();
    await releaseSnapshot.promise;
    return respond(200, {
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });

  await startPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.vm0.ai",
  });

  await screen.findByRole("status", { name: "Loading" });
  await snapshotRequested.promise;

  context.store.set(detachedNavigateTo$, ROUTES.error, { replace: true });

  await waitForErrorPage();
  await waitFor(() => {
    expect(capturedEvents(BOOTSTRAP_PHASE_TIMING_EVENT)).toHaveLength(1);
  });
  expect(capturedEvents(BOOTSTRAP_PHASE_TIMING_EVENT)[0]).toStrictEqual(
    expect.objectContaining({
      final_route: ROUTES.error,
      initial_route: ROUTES.chat,
    }),
  );
  expect(capturedEvents(BOOTSTRAP_PHASE_TIMING_EVENT)[0]).not.toHaveProperty(
    "thread_metadata_source",
  );
  expect(capturedEvents(BOOTSTRAP_PHASE_TIMING_EVENT)[0]).not.toHaveProperty(
    "local_thread_metadata_ms",
  );
  expect(capturedEvents(BOOTSTRAP_PHASE_TIMING_EVENT)[0]).not.toHaveProperty(
    "remote_thread_metadata_ms",
  );

  releaseSnapshot.resolve();
});

test("Startup is reported once", async () => {
  await setupPage({ context, path: ROUTES.error, host: "app.vm0.ai" });

  await waitForErrorPage();
  await context.store.set(hideAppSkeleton$, context.signal);
  await context.store.set(hideAppSkeleton$, context.signal);

  expect(capturedEvents("app_first_skeleton_hide")).toHaveLength(1);
  expect(capturedEvents(BOOTSTRAP_PHASE_TIMING_EVENT)).toHaveLength(1);
});

test("Startup timing is bounded and anonymous", async () => {
  mockMissingConversation();

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.vm0.ai",
  });

  await screen.findByTestId("labeled-nav-rail");
  await waitFor(() => {
    expect(capturedEvents(BOOTSTRAP_PHASE_TIMING_EVENT)).toHaveLength(1);
  });
  const timing = capturedEvents(BOOTSTRAP_PHASE_TIMING_EVENT)[0];
  expect(timing).toStrictEqual(
    expect.objectContaining({
      entry_module_ready_ms: 10,
      final_route: ROUTES.chat,
      initial_route: ROUTES.chat,
      locale_init_ms: expect.any(Number),
      local_thread_metadata_ms: expect.any(Number),
      remote_thread_metadata_ms: expect.any(Number),
      route_setup_ms: expect.any(Number),
      skeleton_duration_ms: expect.any(Number),
      thread_metadata_source: "not_found",
    }),
  );
  const durations = Object.entries(timing)
    .filter(([name]) => {
      return name.endsWith("_ms");
    })
    .map(([, value]) => {
      return value;
    });
  expect(durations.length).toBeGreaterThan(0);
  expect(
    durations.every((value) => {
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    }),
  ).toBeTruthy();
  expect(JSON.stringify(timing)).not.toContain(THREAD_ID);

  const navigationEntry = {
    entryType: "navigation",
    name: `https://private.example/chats/${THREAD_ID}?token=private`,
    responseEnd: 86.6,
    responseStart: 41.2,
  } as PerformanceNavigationTiming;
  const paintEntry = {
    entryType: "paint",
    name: "first-contentful-paint",
    startTime: 98.4,
  } as PerformanceEntry;
  vi.spyOn(performance, "getEntriesByType").mockImplementation((entryType) => {
    if (entryType === "navigation") {
      return [navigationEntry];
    }
    if (entryType === "paint") {
      return [paintEntry];
    }
    return [];
  });

  captureFirstSkeletonPaint();

  const paintTiming = capturedEvents(APP_FIRST_SKELETON_PAINT_EVENT).at(-1);
  expect(paintTiming).toStrictEqual({
    navigation_response_end_ms: 87,
    navigation_response_start_ms: 41,
    paint_metric: "first-contentful-paint",
    response_end_to_skeleton_paint_ms: 12,
    skeleton_paint_ms: 98,
  });
  expect(JSON.stringify(paintTiming)).not.toContain("private");

  initPostHog();
  const config = context.mocks.posthog().initializations.at(-1)?.config;
  const beforeSend = config?.before_send;
  if (typeof beforeSend !== "function") {
    throw new Error("PostHog before_send was not configured");
  }
  const sanitized = beforeSend({
    event: APP_FIRST_SKELETON_PAINT_EVENT,
    properties: {
      $current_url: navigationEntry.name,
      arbitrary_payload: { secret: THREAD_ID },
      distinct_id: "private-user",
      navigation_response_end_ms: 87,
      navigation_response_start_ms: 41,
      paint_metric: "private-metric",
      response_end_to_skeleton_paint_ms: 12,
      skeleton_paint_ms: 98,
      token: "private-token",
    },
    uuid: "public-event-id",
  });

  expect(sanitized).toStrictEqual({
    event: APP_FIRST_SKELETON_PAINT_EVENT,
    properties: {
      $process_person_profile: false,
      distinct_id: "app-bootstrap",
      navigation_response_end_ms: 87,
      navigation_response_start_ms: 41,
      paint_metric: "first-contentful-paint",
      public_brand: "vm0",
      response_end_to_skeleton_paint_ms: 12,
      skeleton_paint_ms: 98,
      token: POSTHOG_KEY,
    },
    uuid: "public-event-id",
  });
  expect(JSON.stringify(sanitized)).not.toContain("private");
  expect(JSON.stringify(sanitized)).not.toContain(THREAD_ID);
});
