import { expect, test, vi } from "vitest";

import { isOkouProductionHostname } from "../lib/platform-host.ts";
import { sentryLogContext } from "../lib/sentry-config.ts";
import { initSharedDatabaseWorkerSentry } from "../shared-database/worker-sentry.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";
import { logger, resetLoggerForTest } from "../signals/log.ts";

const PREVIEW_PLAUSIBLE_URL = "https://preview.plausible.example/js/script.js";
const PRODUCTION_PLAUSIBLE_URL =
  "https://production.plausible.example/js/script.js";
const POSTHOG_KEY = "phc_production_key";
const SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
const PREVIEW_CLERK_KEY = "pk_test_preview";
const PRODUCTION_CLERK_KEY = "pk_live_production";
const PREVIEW_VAPID_KEY = "preview_vapid_key";
const PRODUCTION_VAPID_KEY = "production_vapid_key";

const originalHeadAppendChild = document.head.appendChild.bind(document.head);
const appendedPlausibleScripts: HTMLScriptElement[] = [];
const context = testContext();

function stubPortableBuildInputs(): void {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PREVIEW", PREVIEW_CLERK_KEY);
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PROD", PRODUCTION_CLERK_KEY);
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY_PREVIEW", PREVIEW_VAPID_KEY);
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY_PROD", PRODUCTION_VAPID_KEY);
  vi.stubEnv("VITE_PLAUSIBLE_SCRIPT_URL_PREVIEW", PREVIEW_PLAUSIBLE_URL);
  vi.stubEnv("VITE_PLAUSIBLE_SCRIPT_URL_PRODUCTION", PRODUCTION_PLAUSIBLE_URL);
  vi.stubEnv("VITE_POSTHOG_KEY", POSTHOG_KEY);
  vi.stubEnv("VITE_SENTRY_DSN_PROD", SENTRY_DSN);
}

function appendWithoutLoadingExternalScripts<T extends Node>(node: T): T {
  if (node instanceof HTMLScriptElement && node.src.includes("plausible")) {
    appendedPlausibleScripts.push(node);
    return node;
  }
  return originalHeadAppendChild(node);
}

function prepareRuntime(url: string, apiOriginMarker?: string | null): void {
  appendedPlausibleScripts.length = 0;
  stubPortableBuildInputs();
  context.mocks.browser.url(url, { apiOriginMarker });
  context.mocks.posthog();
  context.mocks.sentry();
  vi.stubGlobal("plausible", undefined);
  vi.stubGlobal("__vm0PlausibleLoadScheduled", undefined);
  vi.stubGlobal(
    "requestIdleCallback",
    (callback: IdleRequestCallback): number => {
      callback({
        didTimeout: false,
        timeRemaining: () => {
          return 50;
        },
      });
      return 1;
    },
  );
  vi.spyOn(document.head, "appendChild").mockImplementation(
    appendWithoutLoadingExternalScripts,
  );
}

async function loadRuntimeSurfaces() {
  const [apiBase, auth, attachmentUrl, userMessageFiles, platformHost] =
    await Promise.all([
      import("../signals/api-base.ts"),
      import("../signals/auth.ts"),
      import("../views/okou-page/attachment-url.ts"),
      import("../signals/chat-page/user-message-files.ts"),
      import("../lib/platform-host.ts"),
    ]);
  return {
    apiBase,
    attachmentUrl,
    auth,
    platformHost,
    userMessageFiles,
  };
}

async function loadTelemetrySurfaces() {
  const [plausible, posthog, sentry] = await Promise.all([
    import("../lib/plausible.ts"),
    import("../lib/posthog.ts"),
    import("../lib/sentry.ts"),
  ]);
  return { plausible, posthog, sentry };
}

async function initializeTelemetry(): Promise<void> {
  const telemetry = await loadTelemetrySurfaces();
  const plausibleController = new AbortController();
  await telemetry.plausible.initPlausible(plausibleController.signal);
  plausibleController.abort();
  telemetry.plausible.capturePlausibleEvent("runtime_environment_test");
  telemetry.posthog.initPostHog();
  telemetry.sentry.initSentry();
}

test("Okou production uses Okou services and branding", async () => {
  prepareRuntime("https://app.okou.ai/agents");
  const runtime = await loadRuntimeSurfaces();

  expect(runtime.apiBase.resolveApiBase()).toBe("https://api.okou.ai");
  expect(
    runtime.userMessageFiles.canonicalUserMessageFileUrl("attachment-photo"),
  ).toBe("https://api.okou.ai/api/web/download-file?file_id=attachment-photo");
  expect(runtime.apiBase.resolveOAuthApiBase()).toBe("https://www.vm0.ai");
  expect(runtime.auth.resolveWebOrigin()).toBe("https://www.vm0.ai");
  expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
    environment: "production",
    publicBrand: "okou",
    publicStaticAssetsBaseUrl: "https://static.okou.io",
    sentryDsn: SENTRY_DSN,
  });
  expect(isOkouProductionHostname("okou.ai.evil.example")).toBeFalsy();

  await initializeTelemetry();

  expect(window.plausible?.q).toStrictEqual([
    ["runtime_environment_test", { props: { public_brand: "okou" } }],
  ]);
  const posthogConfig = context.mocks.posthog().initializations.at(-1)?.config;
  expect(posthogConfig?.sanitize_properties?.({}, "$pageview")).toStrictEqual({
    public_brand: "okou",
  });
  expect(context.mocks.sentry().initializations).toContainEqual({
    options: expect.objectContaining({
      initialScope: {
        tags: { app: "platform", public_brand: "okou" },
      },
    }),
    runtime: "page",
  });
});

test("VM0 production uses VM0 services and branding", async () => {
  prepareRuntime("https://app.vm0.ai/agents");
  const runtime = await loadRuntimeSurfaces();

  expect(runtime.apiBase.resolveApiBase()).toBe("https://api.vm0.ai");
  expect(runtime.auth.resolveWebOrigin()).toBe("https://www.vm0.ai");
  expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
    environment: "production",
    publicBrand: "vm0",
    publicStaticAssetsBaseUrl: "https://static.vm0.io",
    clerkPublishableKey: PRODUCTION_CLERK_KEY,
  });
});

test("Production startup fails closed without a trusted service origin", async () => {
  prepareRuntime("https://app.okou.ai/agents", null);
  const runtime = await loadRuntimeSurfaces();

  expect(() => {
    return runtime.apiBase.resolveApiBase();
  }).toThrow("Missing production API origin marker for app.okou.ai");
});

test("Production startup rejects a brand-mismatched service origin", async () => {
  prepareRuntime("https://app.okou.ai/agents", "https://api.vm0.ai");
  const runtime = await loadRuntimeSurfaces();

  expect(() => {
    return runtime.apiBase.resolveApiBase();
  }).toThrow("Production API origin marker mismatch for app.okou.ai");
});

test("Immutable Preview pages use only an approved Platform service", async () => {
  prepareRuntime(
    "https://3508a2f5.okou-app.pages.dev/agents",
    "https://pr-23364-api.vm6.ai",
  );
  const runtime = await loadRuntimeSurfaces();

  expect(runtime.apiBase.resolveApiBase()).toBe("https://pr-23364-api.vm6.ai");
  expect(runtime.apiBase.resolveOAuthApiBase()).toBe(
    "https://pr-23364-api.vm6.ai",
  );
  expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
    publicBrand: "okou",
    clerkPublishableKey: PREVIEW_CLERK_KEY,
  });
});

test("Immutable Preview pages reject unapproved service origins", async () => {
  prepareRuntime(
    "https://3508a2f5.okou-app.pages.dev/agents",
    "https://example.com",
  );
  const runtime = await loadRuntimeSurfaces();

  expect(() => {
    return runtime.apiBase.resolveApiBase();
  }).toThrow("Invalid Cloudflare Pages preview API origin");
});

test("Unknown page providers stay on their own origin", async () => {
  prepareRuntime(
    "https://deployment.pages.dev/agents",
    "https://pr-23364-api.vm6.ai",
  );
  const runtime = await loadRuntimeSurfaces();

  expect(runtime.apiBase.resolveApiBase()).toBe("https://deployment.pages.dev");
  expect(runtime.auth.resolveWebOrigin()).toBe("https://deployment.pages.dev");
});

test("Conversation synchronization reports terminal errors without reporting recoverable warnings", () => {
  prepareRuntime("https://app.okou.ai/agents");
  initSharedDatabaseWorkerSentry();
  context.signal.addEventListener("abort", resetLoggerForTest, {
    once: true,
  });
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const workerLogger = logger("SharedDatabaseWorkerTest");

  const warning = new Error("recoverable worker warning");
  workerLogger.warn(warning);

  expect(consoleWarn).toHaveBeenCalledWith(
    "[W][SharedDatabaseWorkerTest]",
    warning,
  );
  expect(context.mocks.sentry().reports).toStrictEqual([]);

  const error = new Error("terminal worker error");
  const reportContext = sentryLogContext({
    contexts: { shared_database: { org_id: "org_test" } },
    tags: { "shared_database.operation": "sync.error" },
    user: { id: "user_test" },
  });
  workerLogger.error(error, reportContext);

  expect(consoleError).toHaveBeenCalledWith(
    "[E][SharedDatabaseWorkerTest]",
    error,
    reportContext,
  );
  expect(context.mocks.sentry().reports).toStrictEqual([
    {
      context: {
        contexts: { shared_database: { org_id: "org_test" } },
        tags: {
          logger: "SharedDatabaseWorkerTest",
          "shared_database.operation": "sync.error",
        },
        user: { id: "user_test" },
      },
      error,
      runtime: "shared-worker",
      type: "exception",
    },
  ]);
  expect(context.mocks.sentry().initializations).toContainEqual({
    options: expect.objectContaining({
      initialScope: {
        tags: {
          app: "platform",
          public_brand: "okou",
          runtime: "shared-worker",
          worker: "shared-database",
        },
      },
    }),
    runtime: "shared-worker",
  });
});
