import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserOptions } from "@sentry/browser";
import type { PostHog, PostHogConfig } from "posthog-js/dist/module.slim";
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

const {
  browserSentryCaptureException,
  browserSentryCaptureMessage,
  browserSentryInit,
  posthogInit,
  sentryInit,
} = vi.hoisted(() => {
  return {
    browserSentryCaptureException:
      vi.fn<typeof import("@sentry/browser").captureException>(),
    browserSentryCaptureMessage:
      vi.fn<typeof import("@sentry/browser").captureMessage>(),
    browserSentryInit: vi.fn<(options: BrowserOptions) => void>(),
    posthogInit:
      vi.fn<(key: string, config?: Partial<PostHogConfig>) => void>(),
    sentryInit: vi.fn<(options: BrowserOptions) => void>(),
  };
});

vi.mock("posthog-js/dist/module.slim", () => {
  return {
    posthog: {
      capture: vi.fn<PostHog["capture"]>(),
      identify: vi.fn<PostHog["identify"]>(),
      init: posthogInit,
      reset: vi.fn<PostHog["reset"]>(),
    },
  };
});

vi.mock("@sentry/react", () => {
  return {
    init: sentryInit,
    setUser: vi.fn<typeof import("@sentry/react").setUser>(),
  };
});

vi.mock("@sentry/browser", () => {
  return {
    captureException: browserSentryCaptureException,
    captureMessage: browserSentryCaptureMessage,
    init: browserSentryInit,
  };
});

const originalHeadAppendChild = document.head.appendChild.bind(document.head);
const appendedPlausibleScripts: HTMLScriptElement[] = [];
const context = testContext();

function setBrowserUrl(url: string, apiOriginMarker?: string | null): void {
  context.mocks.browser.url(url, { apiOriginMarker });
}

function installImmediateIdleCallback(): void {
  vi.stubGlobal(
    "requestIdleCallback",
    (callback: IdleRequestCallback): number => {
      callback({
        didTimeout: false,
        timeRemaining: () => 50,
      });
      return 1;
    },
  );
}

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

async function loadRuntimeSurfaces() {
  vi.stubGlobal("plausible", undefined);
  vi.stubGlobal("__vm0PlausibleLoadScheduled", undefined);
  const [
    apiBase,
    auth,
    attachmentUrl,
    userMessageFiles,
    platformHost,
    plausible,
    posthog,
    sentry,
  ] = await Promise.all([
    import("../signals/api-base.ts"),
    import("../signals/auth.ts"),
    import("../views/okou-page/attachment-url.ts"),
    import("../signals/chat-page/user-message-files.ts"),
    import("../lib/platform-host.ts"),
    import("../lib/plausible.ts"),
    import("../lib/posthog.ts"),
    import("../lib/sentry.ts"),
  ]);

  return {
    apiBase,
    attachmentUrl,
    auth,
    userMessageFiles,
    platformHost,
    plausible,
    posthog,
    sentry,
  };
}

function plausibleScriptSources(): string[] {
  return appendedPlausibleScripts.map((script) => script.src);
}

beforeEach(() => {
  vi.resetModules();
  appendedPlausibleScripts.length = 0;
  stubPortableBuildInputs();
  installImmediateIdleCallback();
  vi.spyOn(document.head, "appendChild").mockImplementation(
    appendWithoutLoadingExternalScripts,
  );
});

describe("portable platform runtime environment", () => {
  it("selects Okou API services and public config on app.okou.ai", async () => {
    setBrowserUrl("https://app.okou.ai/agents");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe("https://api.okou.ai");
    expect(
      runtime.userMessageFiles.canonicalUserMessageFileUrl("attachment-photo"),
    ).toBe(
      "https://api.okou.ai/api/web/download-file?file_id=attachment-photo",
    );
    expect(runtime.apiBase.resolveOAuthApiBase()).toBe("https://www.vm0.ai");
    expect(runtime.auth.resolveWebOrigin()).toBe("https://www.vm0.ai");
    expect(isOkouProductionHostname("okou.ai.evil.example")).toBeFalsy();
    expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
      environment: "production",
      publicBrand: "okou",
      publicStaticAssetsBaseUrl: "https://static.okou.io",
      sentryDsn: SENTRY_DSN,
      vapidPublicKey: PRODUCTION_VAPID_KEY,
      clerkPublishableKey: PRODUCTION_CLERK_KEY,
    });
    const plausibleController = new AbortController();
    await runtime.plausible.initPlausible(plausibleController.signal);
    plausibleController.abort();
    runtime.plausible.capturePlausibleEvent("runtime_environment_test");
    runtime.posthog.initPostHog();
    runtime.sentry.initSentry();

    expect(window.plausible?.q).toStrictEqual([
      ["runtime_environment_test", { props: { public_brand: "okou" } }],
    ]);
    const [, posthogConfig] = posthogInit.mock.lastCall ?? [];
    expect(posthogConfig?.sanitize_properties?.({}, "$pageview")).toStrictEqual(
      { public_brand: "okou" },
    );
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        initialScope: {
          tags: { app: "platform", public_brand: "okou" },
        },
      }),
    );
  });

  it("selects the VM0 API service on app.vm0.ai", async () => {
    setBrowserUrl("https://app.vm0.ai/agents");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe("https://api.vm0.ai");
    expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
      environment: "production",
      publicBrand: "vm0",
      publicStaticAssetsBaseUrl: "https://static.vm0.io",
      clerkPublishableKey: PRODUCTION_CLERK_KEY,
    });
  });

  it.each([
    ["missing", "https://app.okou.ai/agents", undefined, "app.okou.ai"],
    ["empty", "https://app.okou.ai/agents", "", "app.okou.ai"],
    ["missing", "https://app.vm0.ai/agents", undefined, "app.vm0.ai"],
    ["empty", "https://app.vm0.ai/agents", "", "app.vm0.ai"],
  ])(
    "fails closed when the production API origin marker is %s on %s",
    async (_state, appUrl, marker, hostname) => {
      setBrowserUrl(appUrl, marker ?? null);
      const runtime = await loadRuntimeSurfaces();

      expect(() => runtime.apiBase.resolveApiBase()).toThrow(
        `Missing production API origin marker for ${hostname}`,
      );
    },
  );

  it.each([
    ["https://app.okou.ai/agents", "https://api.vm0.ai", "app.okou.ai"],
    ["https://app.vm0.ai/agents", "https://api.okou.ai", "app.vm0.ai"],
  ])(
    "rejects a mismatched production API origin marker on %s",
    async (appUrl, apiOrigin, hostname) => {
      setBrowserUrl(appUrl, apiOrigin);
      const runtime = await loadRuntimeSurfaces();

      expect(() => runtime.apiBase.resolveApiBase()).toThrow(
        `Production API origin marker mismatch for ${hostname}`,
      );
    },
  );

  it("selects canonical services and production telemetry on an alternate production host", async () => {
    setBrowserUrl("https://cf-app.vm0.ai/agents");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe("https://api.vm0.ai");
    expect(runtime.auth.resolveWebOrigin()).toBe("https://www.vm0.ai");
    expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
      publicBrand: "vm0",
      postHogHost: "https://j.okou.io",
      vapidPublicKey: PRODUCTION_VAPID_KEY,
      clerkPublishableKey: PRODUCTION_CLERK_KEY,
    });
    expect(
      runtime.attachmentUrl.publicAttachmentUrl(
        "/artifacts/user_1/artifact_1/report.html",
      ),
    ).toBe("https://cdn.vm0.io/artifacts/user_1/artifact_1/report.html");

    const plausibleController = new AbortController();
    await runtime.plausible.initPlausible(plausibleController.signal);
    plausibleController.abort();
    runtime.plausible.capturePlausibleEvent("runtime_environment_test");
    runtime.posthog.initPostHog();
    runtime.sentry.initSentry();

    expect(plausibleScriptSources()).toStrictEqual([PRODUCTION_PLAUSIBLE_URL]);
    expect(window.plausible?.q).toStrictEqual([
      ["runtime_environment_test", { props: { public_brand: "vm0" } }],
    ]);
    expect(posthogInit).toHaveBeenCalledWith(
      POSTHOG_KEY,
      expect.objectContaining({ api_host: "https://j.okou.io" }),
    );
    const [, posthogConfig] = posthogInit.mock.lastCall ?? [];
    expect(
      posthogConfig?.sanitize_properties?.(
        {
          $current_url:
            "https://app.vm0.ai/agents/00000000-0000-0000-0000-000000000000",
        },
        "$pageview",
      ),
    ).toStrictEqual({
      $current_url: "https://app.vm0.ai/agents/:id",
      public_brand: "vm0",
    });
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: SENTRY_DSN,
        enabled: true,
        enhanceFetchErrorMessages: false,
        environment: "production",
        initialScope: {
          tags: { app: "platform", public_brand: "vm0" },
        },
      }),
    );
    const [pageSentryOptions] = sentryInit.mock.lastCall ?? [];
    expect(pageSentryOptions).not.toHaveProperty("beforeBreadcrumb");
  });

  it("preserves preview services and suppresses production telemetry", async () => {
    setBrowserUrl("https://pr-21537-app.omby.ai/agents");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe(
      "https://pr-21537-api.vm6.ai",
    );
    expect(runtime.apiBase.resolveOAuthApiBase()).toBe(
      "https://pr-21537-api.vm6.ai",
    );
    expect(runtime.auth.resolveWebOrigin()).toBe(
      "https://pr-21537-www.omby.ai",
    );
    expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
      environment: "preview",
      publicBrand: "okou",
      publicStaticAssetsBaseUrl: "https://static.okou.io",
      vapidPublicKey: PREVIEW_VAPID_KEY,
      clerkPublishableKey: PREVIEW_CLERK_KEY,
    });
    expect(
      runtime.attachmentUrl.publicAttachmentUrl(
        "/artifacts/user_1/artifact_1/report.html",
      ),
    ).toBe("https://cdn.vm7.io/artifacts/user_1/artifact_1/report.html");

    const plausibleController = new AbortController();
    await runtime.plausible.initPlausible(plausibleController.signal);
    plausibleController.abort();
    runtime.plausible.capturePlausibleEvent("runtime_environment_test", {
      props: { surface: "preview" },
    });
    runtime.posthog.initPostHog();
    runtime.sentry.initSentry();

    expect(plausibleScriptSources()).toStrictEqual([PREVIEW_PLAUSIBLE_URL]);
    expect(window.plausible?.q).toStrictEqual([
      [
        "runtime_environment_test",
        { props: { public_brand: "okou", surface: "preview" } },
      ],
    ]);
    expect(posthogInit).not.toHaveBeenCalled();
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: undefined,
        enabled: false,
        environment: "preview",
        initialScope: {
          tags: { app: "platform", public_brand: "okou" },
        },
      }),
    );
  });

  it("initializes shared worker Sentry and only reports error logs", () => {
    setBrowserUrl("https://app.okou.ai/agents");
    initSharedDatabaseWorkerSentry();
    context.signal.addEventListener("abort", resetLoggerForTest, {
      once: true,
    });

    expect(browserSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: SENTRY_DSN,
        enabled: true,
        initialScope: {
          tags: {
            app: "platform",
            public_brand: "okou",
            runtime: "shared-worker",
            worker: "shared-database",
          },
        },
      }),
    );

    const [workerSentryOptions] = browserSentryInit.mock.lastCall ?? [];
    const warningBreadcrumb = {
      category: "console",
      message: "recoverable worker warning",
    };
    expect(
      workerSentryOptions?.beforeBreadcrumb?.(warningBreadcrumb),
    ).toBeNull();
    const fetchBreadcrumb = {
      category: "fetch",
      message: "GET /api/zero/shared-database",
    };
    expect(workerSentryOptions?.beforeBreadcrumb?.(fetchBreadcrumb)).toBe(
      fetchBreadcrumb,
    );

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const workerLogger = logger("SharedDatabaseWorkerTest");
    const warning = new Error("recoverable worker warning");
    workerLogger.warn(warning);

    expect(consoleWarn).toHaveBeenCalledWith(
      "[W][SharedDatabaseWorkerTest]",
      warning,
    );
    expect(browserSentryCaptureException).not.toHaveBeenCalled();
    expect(browserSentryCaptureMessage).not.toHaveBeenCalled();

    const error = new Error("terminal worker error");
    const sentryContext = sentryLogContext({
      contexts: { shared_database: { org_id: "org_test" } },
      tags: { "shared_database.operation": "sync.error" },
      user: { id: "user_test" },
    });
    workerLogger.error(error, sentryContext);

    expect(consoleError).toHaveBeenCalledWith(
      "[E][SharedDatabaseWorkerTest]",
      error,
      sentryContext,
    );
    expect(browserSentryCaptureException).toHaveBeenCalledWith(error, {
      contexts: { shared_database: { org_id: "org_test" } },
      tags: {
        logger: "SharedDatabaseWorkerTest",
        "shared_database.operation": "sync.error",
      },
      user: { id: "user_test" },
    });
    expect(browserSentryCaptureMessage).not.toHaveBeenCalled();
  });

  it("keeps preview WWW on omby.ai while routing API through vm6.ai", async () => {
    setBrowserUrl("https://pr-22085-app.omby.ai/agents");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe(
      "https://pr-22085-api.vm6.ai",
    );
    expect(runtime.apiBase.resolveOAuthApiBase()).toBe(
      "https://pr-22085-api.vm6.ai",
    );
    expect(runtime.auth.resolveWebOrigin()).toBe(
      "https://pr-22085-www.omby.ai",
    );
    expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
      environment: "preview",
      vapidPublicKey: PREVIEW_VAPID_KEY,
      clerkPublishableKey: PREVIEW_CLERK_KEY,
    });
  });

  it("uses the configured API for an immutable Pages deployment", async () => {
    setBrowserUrl(
      "https://3508a2f5.okou-app.pages.dev/agents",
      "https://pr-23364-api.vm6.ai",
    );
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe(
      "https://pr-23364-api.vm6.ai",
    );
    expect(runtime.apiBase.resolveOAuthApiBase()).toBe(
      "https://pr-23364-api.vm6.ai",
    );
    expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
      publicBrand: "okou",
      clerkPublishableKey: PREVIEW_CLERK_KEY,
    });
  });

  it("rejects an invalid API origin on an immutable Pages deployment", async () => {
    setBrowserUrl(
      "https://3508a2f5.okou-app.pages.dev/agents",
      "https://example.com",
    );
    const runtime = await loadRuntimeSurfaces();

    expect(() => runtime.apiBase.resolveApiBase()).toThrow(
      "Invalid Cloudflare Pages preview API origin",
    );
  });

  it("keeps unrecognized provider hosts on the same origin", async () => {
    setBrowserUrl(
      "https://deployment.pages.dev/agents",
      "https://pr-23364-api.vm6.ai",
    );
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe(
      "https://deployment.pages.dev",
    );
    expect(runtime.auth.resolveWebOrigin()).toBe(
      "https://deployment.pages.dev",
    );
  });
});
