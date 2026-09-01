import { waitFor } from "@testing-library/react";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { detachedSetupPage, setupPage } from "../../__tests__/page-helper.ts";
import {
  BOOTSTRAP_PHASE_TIMING_EVENT,
  type BootstrapThreadMetadataSource,
} from "../../lib/posthog.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { testContext } from "./test-helpers.ts";

type Capture = (
  eventName: string,
  properties?: Record<string, unknown>,
) => void;
type Identify = (
  distinctId: string,
  properties?: Record<string, unknown>,
) => void;
interface CapturedPostHogEvent {
  readonly event: string;
  readonly properties: Record<string, unknown>;
  readonly timestamp?: string;
  readonly uuid: string;
  readonly [property: string]: unknown;
}

type BeforeSend = (
  event: CapturedPostHogEvent | null,
) => CapturedPostHogEvent | null;
type Init = (
  key: string,
  config?: { readonly before_send?: BeforeSend },
) => void;
type Register = (properties: Record<string, unknown>) => void;
type Reset = () => void;
type Unregister = (property: string) => void;

const { apiOriginMarker, posthog } = vi.hoisted(() => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_bootstrap_phase_telemetry_test");
  window.location.href = "https://app.vm0.ai/";
  const apiOriginMarker = document.createElement("meta");
  apiOriginMarker.name = "vm0-api-origin";
  apiOriginMarker.content = "https://api.vm0.ai";
  document.head.append(apiOriginMarker);
  return {
    apiOriginMarker,
    posthog: {
      capture: vi.fn<Capture>(),
      identify: vi.fn<Identify>(),
      init: vi.fn<Init>(),
      register: vi.fn<Register>(),
      reset: vi.fn<Reset>(),
      unregister: vi.fn<Unregister>(),
    },
  };
});

vi.mock("posthog-js/dist/module.slim", () => {
  return { posthog };
});

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000901";

beforeEach(() => {
  posthog.capture.mockClear();
  posthog.identify.mockClear();
  posthog.init.mockClear();
  posthog.register.mockClear();
  posthog.reset.mockClear();
  posthog.unregister.mockClear();
  context.mocks.browser.standaloneDisplayMode(false);
  context.mocks.browser.visibilityState("visible");

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

function timingEvents(): Record<string, unknown>[] {
  return posthog.capture.mock.calls.flatMap(([eventName, properties]) => {
    return eventName === BOOTSTRAP_PHASE_TIMING_EVENT ? [properties ?? {}] : [];
  });
}

function mockEmptyThreadMetadata(): void {
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

describe("bootstrap phase telemetry", () => {
  it("captures bounded bootstrap and cold thread metadata phases", async () => {
    mockEmptyThreadMetadata();

    await setupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      withoutRender: true,
    });

    expect(timingEvents()).toHaveLength(1);
    const properties = timingEvents()[0];
    expect(properties).toStrictEqual(
      expect.objectContaining({
        entry_module_ready_ms: 10,
        final_route: ROUTES.chat,
        initial_route: ROUTES.chat,
        initial_visibility_state: "visible",
        locale_init_ms: expect.any(Number),
        local_thread_metadata_ms: expect.any(Number),
        remote_thread_metadata_ms: expect.any(Number),
        route_setup_ms: expect.any(Number),
        skeleton_duration_ms: expect.any(Number),
        standalone_pwa: false,
        thread_metadata_source:
          "not_found" satisfies BootstrapThreadMetadataSource,
        visibility_state: "visible",
        was_hidden: false,
      }),
    );
    const skeletonDurationMs = properties?.skeleton_duration_ms;
    if (typeof skeletonDurationMs !== "number") {
      throw new TypeError("expected a numeric skeleton duration");
    }
    expect(Number.isFinite(skeletonDurationMs)).toBeTruthy();
    expect(skeletonDurationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(properties)).not.toContain(THREAD_ID);
  });

  it("reports the bootstrap event only once", async () => {
    await setupPage({ context, path: ROUTES.error, withoutRender: true });

    context.store.set(hideAppSkeleton$, context.signal);
    context.store.set(hideAppSkeleton$, context.signal);

    expect(timingEvents()).toHaveLength(1);
    expect(
      posthog.capture.mock.calls.flatMap(([eventName]) => {
        return eventName === "app_first_skeleton_hide" ||
          eventName === BOOTSTRAP_PHASE_TIMING_EVENT
          ? [eventName]
          : [];
      }),
    ).toStrictEqual(["app_first_skeleton_hide", BOOTSTRAP_PHASE_TIMING_EVENT]);
    expect(timingEvents()[0]).toStrictEqual(
      expect.objectContaining({ skeleton_duration_ms: expect.any(Number) }),
    );
  });

  it("discards thread timing from an aborted navigation", async () => {
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

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      withoutRender: true,
    });
    await snapshotRequested.promise;

    context.store.set(detachedNavigateTo$, ROUTES.error, { replace: true });

    await waitFor(() => {
      expect(timingEvents()).toHaveLength(1);
    });
    expect(timingEvents()[0]).toStrictEqual(
      expect.objectContaining({
        final_route: ROUTES.error,
        initial_route: ROUTES.chat,
      }),
    );
    expect(timingEvents()[0]).not.toHaveProperty("thread_metadata_source");
    expect(timingEvents()[0]).not.toHaveProperty("local_thread_metadata_ms");
    expect(timingEvents()[0]).not.toHaveProperty("remote_thread_metadata_ms");

    releaseSnapshot.resolve();
  });

  it("omits an unavailable entry timing mark", async () => {
    delete window.__appBootstrapStart;
    delete window.__appBootstrapModuleReady;

    await setupPage({ context, path: ROUTES.error, withoutRender: true });

    expect(timingEvents()).toHaveLength(1);
    expect(timingEvents()[0]).not.toHaveProperty("entry_module_ready_ms");
    expect(timingEvents()[0]).not.toHaveProperty("skeleton_duration_ms");
    expect(timingEvents()[0]).toStrictEqual(
      expect.objectContaining({
        final_route: ROUTES.error,
        initial_route: ROUTES.error,
        locale_init_ms: expect.any(Number),
        route_setup_ms: expect.any(Number),
      }),
    );
    expect(
      posthog.capture.mock.calls.filter(([eventName]) => {
        return eventName === "app_first_skeleton_hide";
      }),
    ).toHaveLength(0);
  });

  it("omits an invalid skeleton timing without changing the total event", async () => {
    window.__appBootstrapStart = Number.NaN;

    await setupPage({ context, path: ROUTES.error, withoutRender: true });

    expect(timingEvents()).toHaveLength(1);
    expect(timingEvents()[0]).not.toHaveProperty("skeleton_duration_ms");
    expect(
      posthog.capture.mock.calls.filter(([eventName]) => {
        return eventName === "app_first_skeleton_hide";
      }),
    ).toHaveLength(1);
  });
});
