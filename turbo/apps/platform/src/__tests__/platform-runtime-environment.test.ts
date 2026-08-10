import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOkouProductionHostname } from "../lib/platform-host.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const PREVIEW_PLAUSIBLE_URL = "https://preview.plausible.example/js/script.js";
const PRODUCTION_PLAUSIBLE_URL =
  "https://production.plausible.example/js/script.js";
const POSTHOG_KEY = "phc_production_key";
const SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
const PREVIEW_CLERK_KEY = "pk_test_preview";
const PRODUCTION_CLERK_KEY = "pk_live_production";
const PREVIEW_VAPID_KEY = "preview_vapid_key";
const PRODUCTION_VAPID_KEY = "production_vapid_key";

const { posthogInit, sentryInit } = vi.hoisted(() => {
  return {
    posthogInit: vi.fn(),
    sentryInit: vi.fn(),
  };
});

vi.mock("posthog-js", () => {
  return {
    posthog: {
      capture: vi.fn(),
      identify: vi.fn(),
      init: posthogInit,
      reset: vi.fn(),
    },
  };
});

vi.mock("@sentry/react", () => {
  return {
    init: sentryInit,
    setUser: vi.fn(),
  };
});

const originalHeadAppendChild = document.head.appendChild.bind(document.head);
const appendedPlausibleScripts: HTMLScriptElement[] = [];
const context = testContext();

function setBrowserUrl(url: string): void {
  context.mocks.browser.url(url);
}

function setPreviewApiOrigin(origin: string): void {
  const element = document.createElement("meta");
  element.name = "vm0-api-origin";
  element.content = origin;
  document.head.append(element);
  context.signal.addEventListener("abort", () => element.remove(), {
    once: true,
  });
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
    import("../views/zero-page/zero-attachment-url.ts"),
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
  it("selects production services and public config on an okou.ai subdomain", async () => {
    setBrowserUrl("https://console.okou.ai/agents");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe("https://api.vm0.ai");
    expect(
      runtime.userMessageFiles.canonicalUserMessageFileUrl("attachment-photo"),
    ).toBe(
      "https://api.vm0.ai/api/okou/web/download-file?file_id=attachment-photo",
    );
    expect(runtime.apiBase.resolveOAuthApiBase()).toBe("https://www.vm0.ai");
    expect(runtime.auth.resolveWebOrigin()).toBe("https://www.vm0.ai");
    expect(isOkouProductionHostname("okou.ai.evil.example")).toBeFalsy();
    expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
      environment: "production",
      clerkPublishableKey: PRODUCTION_CLERK_KEY,
      sentryDsn: SENTRY_DSN,
      vapidPublicKey: PRODUCTION_VAPID_KEY,
    });
  });

  it("selects canonical services and production telemetry on an alternate production host", async () => {
    setBrowserUrl("https://cf-app.vm0.ai/agents");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe("https://api.vm0.ai");
    expect(runtime.auth.resolveWebOrigin()).toBe("https://www.vm0.ai");
    expect(runtime.platformHost.resolvePlatformRuntimeConfig()).toMatchObject({
      clerkPublishableKey: PRODUCTION_CLERK_KEY,
      vapidPublicKey: PRODUCTION_VAPID_KEY,
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
      ["runtime_environment_test", undefined],
    ]);
    expect(posthogInit).toHaveBeenCalledWith(
      POSTHOG_KEY,
      expect.objectContaining({ api_host: "https://j.vm0.ai" }),
    );
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: SENTRY_DSN,
        enabled: true,
        enhanceFetchErrorMessages: false,
        environment: "production",
      }),
    );
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
      clerkPublishableKey: PREVIEW_CLERK_KEY,
      vapidPublicKey: PREVIEW_VAPID_KEY,
    });
    expect(
      runtime.attachmentUrl.publicAttachmentUrl(
        "/artifacts/user_1/artifact_1/report.html",
      ),
    ).toBe("https://cdn.vm7.io/artifacts/user_1/artifact_1/report.html");

    const plausibleController = new AbortController();
    await runtime.plausible.initPlausible(plausibleController.signal);
    plausibleController.abort();
    runtime.posthog.initPostHog();
    runtime.sentry.initSentry();

    expect(plausibleScriptSources()).toStrictEqual([PREVIEW_PLAUSIBLE_URL]);
    expect(posthogInit).not.toHaveBeenCalled();
    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: undefined,
        enabled: false,
        environment: "preview",
      }),
    );
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
      clerkPublishableKey: PREVIEW_CLERK_KEY,
      vapidPublicKey: PREVIEW_VAPID_KEY,
    });
  });

  it("uses the configured API for an immutable Pages deployment", async () => {
    setBrowserUrl("https://3508a2f5.okou-app.pages.dev/agents");
    setPreviewApiOrigin("https://pr-23364-vm0-api-preview.vm0.workers.dev");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe(
      "https://pr-23364-vm0-api-preview.vm0.workers.dev",
    );
    expect(runtime.apiBase.resolveOAuthApiBase()).toBe(
      "https://pr-23364-vm0-api-preview.vm0.workers.dev",
    );
  });

  it("uses the configured Worker API from the app preview gateway", async () => {
    setBrowserUrl("https://pr-23364-app.omby.ai/agents");
    setPreviewApiOrigin("https://pr-23364-vm0-api-preview.vm0.workers.dev");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe(
      "https://pr-23364-vm0-api-preview.vm0.workers.dev",
    );
    expect(runtime.apiBase.resolveOAuthApiBase()).toBe(
      "https://pr-23364-vm0-api-preview.vm0.workers.dev",
    );
  });

  it("rejects the retired Vercel API from the app preview gateway", async () => {
    setBrowserUrl("https://pr-23364-app.omby.ai/agents");
    setPreviewApiOrigin("https://pr-23364-api.vm6.ai");
    const runtime = await loadRuntimeSurfaces();

    expect(() => runtime.apiBase.resolveApiBase()).toThrow(
      "Invalid Cloudflare Pages preview API origin",
    );
  });

  it("rejects an invalid API origin on an immutable Pages deployment", async () => {
    setBrowserUrl("https://3508a2f5.okou-app.pages.dev/agents");
    setPreviewApiOrigin("https://example.com");
    const runtime = await loadRuntimeSurfaces();

    expect(() => runtime.apiBase.resolveApiBase()).toThrow(
      "Invalid Cloudflare Pages preview API origin",
    );
  });

  it("keeps unrecognized provider hosts on the same origin", async () => {
    setBrowserUrl("https://deployment.pages.dev/agents");
    setPreviewApiOrigin("https://pr-23364-vm0-api-preview.vm0.workers.dev");
    const runtime = await loadRuntimeSurfaces();

    expect(runtime.apiBase.resolveApiBase()).toBe(
      "https://deployment.pages.dev",
    );
    expect(runtime.auth.resolveWebOrigin()).toBe(
      "https://deployment.pages.dev",
    );
  });
});
