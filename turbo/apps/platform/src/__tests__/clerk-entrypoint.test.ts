import type { OnboardingStatusResponse } from "@okouai/api-contracts/contracts/onboarding";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import indexHtml from "../../index.html?raw";
import { transformClerkCoreScriptUrls } from "../../scripts/clerk-html-transform.ts";
import { CLERK_JS_VERSION } from "../lib/clerk-versions.ts";
import { resolvePlatformRuntimeConfig } from "../lib/platform-host.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";
import { onboardingStatus$ } from "../signals/okou-page/onboarding.ts";
import {
  clearMockedAuthOnAbort,
  mockedClerk,
  mockedClerkLoad,
  mockOrganization,
  mockUser,
} from "./mock-auth.ts";
import { setupPage } from "./page-helper.ts";

vi.unmock("@clerk/shared/loadClerkJsScript");

const PREVIEW_FRONTEND_API_HOST = "informed-calf-6.clerk.accounts.dev";
const PRODUCTION_FRONTEND_API_HOST = "clerk.vm0.ai";
const CURRENT_PRIMARY_APP_DOMAIN = "app.vm0.ai";
const CUTOVER_PRIMARY_APP_DOMAIN = "app.okou.ai";
const CLERK_BOOTSTRAP_SELECTOR = "script[data-vm0-clerk-bootstrap]";
const CLERK_CORE_SCRIPT_ID = "vm0-clerk-core-script";
const CLERK_SCRIPT_SELECTOR = "script[data-clerk-js-script]";
const TEST_APP_VERSION = "0.812.5-test";
const CLERK_LOAD_COMPLETED_MARK = "vm0:bootstrap:clerk-load-completed";
const CLERK_LOAD_STARTED_MARK = "vm0:bootstrap:clerk-load-started";

const PREFETCHED_ONBOARDING_STATUS: OnboardingStatusResponse = {
  defaultAgentId: "c0000000-0000-4000-a000-000000000101",
  defaultAgentMetadata: { displayName: "Prefetched Zero" },
  hasDefaultAgent: true,
  hasOrg: true,
  isAdmin: true,
  needsOnboarding: false,
  onboardingComplete: true,
};

const RETRIED_ONBOARDING_STATUS: OnboardingStatusResponse = {
  ...PREFETCHED_ONBOARDING_STATUS,
  defaultAgentId: "c0000000-0000-4000-a000-000000000102",
  defaultAgentMetadata: { displayName: "Retried Zero" },
};

type ClerkBootstrapScript = (
  window: Window,
  document: Document,
  location: Location,
) => void;

interface ClerkScriptRequest {
  readonly element: HTMLScriptElement;
  readonly url: string;
}

interface ClerkEntrypointHarness {
  readonly clerkLoaderWatchingEarlyScript: Promise<void>;
  readonly earlyScript: HTMLScriptElement;
  readonly requests: ClerkScriptRequest[];
  readonly retryStarted: Promise<void>;
  readonly setup: Promise<void>;
}

interface ClerkPageOptions {
  readonly apiOriginMarker?: string | null;
  readonly cookie?: string;
  readonly path?: string;
  readonly productionPublishableKey?: string;
  readonly productionPrimaryAppDomain?:
    | typeof CURRENT_PRIMARY_APP_DOMAIN
    | typeof CUTOVER_PRIMARY_APP_DOMAIN;
  readonly url?: string;
}

const context = testContext();

function publishableKey(environment: "live" | "test", host: string): string {
  return `pk_${environment}_${btoa(`${host}$`)}`;
}

const PREVIEW_PUBLISHABLE_KEY = publishableKey(
  "test",
  PREVIEW_FRONTEND_API_HOST,
);
const PRODUCTION_PUBLISHABLE_KEY = publishableKey(
  "live",
  PRODUCTION_FRONTEND_API_HOST,
);
function expectedClerkScriptUrl(): string {
  return `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`;
}

function expectedFallbackClerkScriptUrl(host: string): string {
  return `https://${host}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`;
}

function stubClerkBuildEnvironment(
  productionPublishableKey = PRODUCTION_PUBLISHABLE_KEY,
): void {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PREVIEW", PREVIEW_PUBLISHABLE_KEY);
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PROD", productionPublishableKey);
}

function builtIndexHtml(
  appVersion = TEST_APP_VERSION,
  productionPublishableKey = PRODUCTION_PUBLISHABLE_KEY,
  productionPrimaryAppDomain = CURRENT_PRIMARY_APP_DOMAIN,
): string {
  return transformClerkCoreScriptUrls(
    indexHtml
      .replaceAll(
        "%VITE_CLERK_PUBLISHABLE_KEY_PREVIEW%",
        PREVIEW_PUBLISHABLE_KEY,
      )
      .replaceAll("%VITE_CLERK_PUBLISHABLE_KEY_PROD%", productionPublishableKey)
      .replaceAll(
        "__VM0_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN__",
        productionPrimaryAppDomain,
      ),
    {
      appVersion,
    },
  );
}

function createClerkCoreScript(html: string): HTMLScriptElement {
  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  const source = parsedDocument.getElementById(CLERK_CORE_SCRIPT_ID);
  if (!(source instanceof HTMLScriptElement)) {
    throw new Error("Built index.html does not contain the Clerk core script");
  }
  const script = document.createElement("script");
  for (const attribute of source.attributes) {
    script.setAttribute(attribute.name, attribute.value);
  }
  return script;
}

function clerkBootstrapSource(html: string): string {
  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  const bootstrap = parsedDocument.querySelector(CLERK_BOOTSTRAP_SELECTOR);
  if (!(bootstrap instanceof HTMLScriptElement)) {
    throw new Error("Built index.html does not contain the Clerk bootstrap");
  }
  return bootstrap.textContent;
}

function executeClerkBootstrap(html: string): void {
  const executeEntrypointScript = new Function(
    "window",
    "document",
    "location",
    `${clerkBootstrapSource(html)}\n//# sourceURL=platform-clerk-bootstrap-test.js`,
  ) as ClerkBootstrapScript;
  executeEntrypointScript(window, document, location);
}

function captureClerkBootstrapScript(
  url: string,
  options: Pick<
    ClerkPageOptions,
    | "apiOriginMarker"
    | "cookie"
    | "productionPublishableKey"
    | "productionPrimaryAppDomain"
  > = {},
): HTMLScriptElement {
  stubClerkBuildEnvironment(options.productionPublishableKey);
  context.mocks.browser.url(url, {
    apiOriginMarker: options.apiOriginMarker,
  });
  if (options.cookie !== undefined) {
    context.mocks.browser.cookie(options.cookie);
  }
  context.signal.addEventListener(
    "abort",
    () => {
      window.dispatchEvent(new Event("pagehide"));
      Reflect.deleteProperty(globalThis, "Clerk");
      Reflect.deleteProperty(window, "__vm0ClerkBootstrap");
      performance.clearMarks(CLERK_LOAD_STARTED_MARK);
      performance.clearMarks(CLERK_LOAD_COMPLETED_MARK);
    },
    { once: true },
  );
  const html = builtIndexHtml(
    TEST_APP_VERSION,
    options.productionPublishableKey,
    options.productionPrimaryAppDomain,
  );
  const clerkScript = createClerkCoreScript(html);
  const scriptUrl = clerkScript.src;
  clerkScript.removeAttribute("src");
  document.head.appendChild(clerkScript);
  executeClerkBootstrap(html);
  clerkScript.remove();
  clerkScript.src = scriptUrl;
  return clerkScript;
}

function startClerkPage(
  options: ClerkPageOptions = {},
): ClerkEntrypointHarness {
  stubClerkBuildEnvironment(options.productionPublishableKey);
  const requests: ClerkScriptRequest[] = [];
  const clerkLoaderWatchingEarlyScript = context.mocks.deferred<void>();
  const retryStarted = context.mocks.deferred<void>();
  let earlyScript: HTMLScriptElement | undefined;

  const setup = setupPage({
    beforeBootstrap: (signal) => {
      context.mocks.browser.url(
        options.url ?? "https://pr-30199-app.omby.ai/",
        { apiOriginMarker: options.apiOriginMarker },
      );
      if (options.cookie !== undefined) {
        context.mocks.browser.cookie(options.cookie);
      }
      Reflect.deleteProperty(globalThis, "Clerk");

      const observeScript = (
        append: typeof document.body.appendChild,
        node: Node,
      ): Node => {
        if (!(node instanceof HTMLScriptElement) || !node.src) {
          return append(node);
        }

        requests.push({ element: node, url: node.src });
        node.removeAttribute("src");
        const appended = append(node);
        if (node.id === CLERK_CORE_SCRIPT_ID) {
          return appended;
        }
        retryStarted.resolve(undefined);
        Reflect.set(globalThis, "Clerk", mockedClerk);
        node.dispatchEvent(new Event("load"));
        return appended;
      };

      const appendToHead = document.head.appendChild.bind(document.head);
      const headAppendSpy = vi
        .spyOn(document.head, "appendChild")
        .mockImplementation((node) => {
          return observeScript(appendToHead, node);
        });
      const appendToBody = document.body.appendChild.bind(document.body);
      const bodyAppendSpy = vi
        .spyOn(document.body, "appendChild")
        .mockImplementation((node) => {
          return observeScript(appendToBody, node);
        });

      const html = builtIndexHtml(
        TEST_APP_VERSION,
        options.productionPublishableKey,
        options.productionPrimaryAppDomain,
      );
      const staticClerkScript = createClerkCoreScript(html);
      document.head.appendChild(staticClerkScript);
      earlyScript = staticClerkScript;
      executeClerkBootstrap(html);
      const addEventListener = earlyScript.addEventListener.bind(earlyScript);
      vi.spyOn(earlyScript, "addEventListener").mockImplementation(
        (type, listener, options) => {
          if (type === "error") {
            clerkLoaderWatchingEarlyScript.resolve(undefined);
          }
          addEventListener(type, listener, options);
        },
      );

      signal.addEventListener(
        "abort",
        () => {
          headAppendSpy.mockRestore();
          bodyAppendSpy.mockRestore();
          window.dispatchEvent(new Event("pagehide"));
          for (const request of requests) {
            request.element.remove();
          }
          Reflect.deleteProperty(globalThis, "Clerk");
          Reflect.deleteProperty(window, "__vm0ClerkBootstrap");
          performance.clearMarks(CLERK_LOAD_STARTED_MARK);
          performance.clearMarks(CLERK_LOAD_COMPLETED_MARK);
        },
        { once: true },
      );
    },
    context,
    path: options.path ?? "/error",
    withoutRender: true,
  });

  if (!earlyScript) {
    throw new Error("Clerk entrypoint setup did not run synchronously");
  }
  return {
    clerkLoaderWatchingEarlyScript: clerkLoaderWatchingEarlyScript.promise,
    earlyScript,
    requests,
    retryStarted: retryStarted.promise,
    setup,
  };
}

async function loadEarlyClerkScript(
  harness: ClerkEntrypointHarness,
): Promise<void> {
  await harness.clerkLoaderWatchingEarlyScript;
  Reflect.set(globalThis, "Clerk", mockedClerk);
  harness.earlyScript.dispatchEvent(new Event("load"));
}

async function completeEarlyClerkScript(
  harness: ClerkEntrypointHarness,
): Promise<void> {
  await loadEarlyClerkScript(harness);
  await harness.setup;
}

describe("platform Clerk entrypoint", () => {
  it("preserves startup discovery while keeping the skeleton avatar inline", () => {
    const html = builtIndexHtml();
    const parsedDocument = new DOMParser().parseFromString(html, "text/html");
    const skeleton = parsedDocument.getElementById("app-bootstrap-skeleton");
    const clerkCore = parsedDocument.getElementById(CLERK_CORE_SCRIPT_ID);
    const bootstrap = parsedDocument.querySelector(CLERK_BOOTSTRAP_SELECTOR);
    const fontStylesheet = parsedDocument.querySelector(
      'link[rel="stylesheet"][href^="https://fonts.googleapis.com/"]',
    );
    const criticalStyles = parsedDocument.querySelector("head style");
    const mainScript = parsedDocument.querySelector(
      'script[type="module"][src="/src/main.ts"]',
    );
    const externalSkeletonImages = skeleton?.querySelectorAll("img[src]");
    const inlineAvatar = skeleton?.querySelector(
      "svg.app-bootstrap-skeleton__avatar-layers",
    );
    if (!(skeleton instanceof HTMLDivElement)) {
      throw new Error("Built index.html does not contain the app skeleton");
    }
    if (!(clerkCore instanceof HTMLScriptElement)) {
      throw new Error(
        "Built index.html does not contain the Clerk core script",
      );
    }
    if (!(bootstrap instanceof HTMLScriptElement)) {
      throw new Error("Built index.html does not contain the Clerk bootstrap");
    }
    if (!(fontStylesheet instanceof HTMLLinkElement)) {
      throw new Error("Built index.html does not contain the font stylesheet");
    }
    if (!(criticalStyles instanceof HTMLStyleElement)) {
      throw new Error("Built index.html does not contain critical styles");
    }
    if (!(mainScript instanceof HTMLScriptElement)) {
      throw new Error("Built index.html does not contain the app module");
    }

    expect(clerkCore.nextElementSibling).toBe(bootstrap);
    expect(clerkCore.parentElement).toBe(parsedDocument.head);
    expect(bootstrap.parentElement).toBe(parsedDocument.head);
    expect(clerkCore.compareDocumentPosition(bootstrap)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(bootstrap.compareDocumentPosition(mainScript)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(mainScript.compareDocumentPosition(skeleton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(skeleton.compareDocumentPosition(fontStylesheet)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(html).not.toContain("__VM0_");
    expect(html).not.toContain("__vm0AfterFirstPaint");
    expect(html).not.toContain("data-vm0-app-entry");
    expect(clerkCore.src).toBe(expectedClerkScriptUrl());
    expect(clerkCore.defer).toBeTruthy();
    expect(clerkCore.async).toBeFalsy();
    expect(clerkCore.crossOrigin).toBe("anonymous");
    expect(clerkCore.dataset.clerkJsScript).toBeUndefined();
    expect(clerkCore.dataset.clerkPublishableKey).toBeUndefined();
    expect(clerkCore.onload).toBeNull();
    expect(criticalStyles.textContent).toContain(
      "@keyframes app-bootstrap-skeleton-avatar-pulse",
    );
    expect(externalSkeletonImages).toHaveLength(0);
    expect(inlineAvatar).toBeInstanceOf(SVGSVGElement);
    expect(inlineAvatar?.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(html).not.toContain("/assets/avatar-svg/");
    expect(skeleton).toHaveTextContent("");
    expect(fontStylesheet.rel).toBe("stylesheet");
    expect(fontStylesheet.hasAttribute("as")).toBeFalsy();
    expect(html.indexOf("data-vm0-clerk-bootstrap")).toBeLessThan(
      html.indexOf('type="module" src="/src/main.ts"'),
    );
    expect(html).not.toContain("@clerk/ui");
  });

  it("keeps app version metadata inside the Clerk bootstrap script", () => {
    const html = builtIndexHtml(
      `${TEST_APP_VERSION}-bundle-stability"><script data-okou-build-metadata-injection></script>`,
    );
    const parsedDocument = new DOMParser().parseFromString(html, "text/html");

    expect(
      parsedDocument.querySelector(
        "script[data-okou-build-metadata-injection]",
      ),
    ).toBeNull();
    expect(() => clerkBootstrapSource(html)).not.toThrow();
  });

  it("configures the statically discovered Clerk script synchronously", () => {
    const script = captureClerkBootstrapScript("https://app.vm0.ai/");

    expect(script.dataset.clerkJsScript).toBe("");
    expect(script.dataset.clerkPublishableKey).toBe(PRODUCTION_PUBLISHABLE_KEY);
    expect(script.onload).toStrictEqual(expect.any(Function));
    expect(script.onerror).toStrictEqual(expect.any(Function));
  });

  it.each([
    {
      authOrigin: "https://pr-30199-app.omby.ai",
      domain: null,
      publishableKey: PREVIEW_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://pr-30199-app.omby.ai/",
    },
    {
      authOrigin: "https://app.vm0.ai",
      domain: null,
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://app.vm0.ai/",
    },
    {
      authOrigin: "https://app.vm0.ai",
      domain: "app.okou.ai",
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://app.okou.ai/",
    },
    {
      authOrigin: "https://app.okou.ai",
      domain: null,
      productionPrimaryAppDomain: CUTOVER_PRIMARY_APP_DOMAIN,
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://app.okou.ai/",
    },
    {
      authOrigin: "https://app.okou.ai",
      domain: "vm0.ai",
      productionPrimaryAppDomain: CUTOVER_PRIMARY_APP_DOMAIN,
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://app.vm0.ai/",
    },
    {
      authOrigin: "https://okou.ai.evil.example",
      domain: null,
      publishableKey: PREVIEW_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://okou.ai.evil.example/",
    },
  ])(
    "selects the Clerk core configuration on $url",
    ({
      authOrigin,
      domain,
      productionPrimaryAppDomain,
      publishableKey,
      scriptUrl,
      url,
    }) => {
      const script = captureClerkBootstrapScript(url, {
        productionPrimaryAppDomain:
          productionPrimaryAppDomain as ClerkPageOptions["productionPrimaryAppDomain"],
      });
      const bootstrap = window.__vm0ClerkBootstrap;
      if (!bootstrap) {
        throw new Error("Clerk bootstrap did not expose its shared state");
      }

      // The inline bootstrap and module runtime select the key independently,
      // so they must agree on every hostname.
      expect(resolvePlatformRuntimeConfig().clerkPublishableKey).toBe(
        publishableKey,
      );
      expect(script.src).toBe(scriptUrl);
      expect(script.defer).toBeTruthy();
      expect(script.async).toBeFalsy();
      expect(script.crossOrigin).toBe("anonymous");
      expect(script.dataset.clerkJsScript).toBe("");
      expect(script.dataset.clerkPublishableKey).toBe(publishableKey);
      expect(script.dataset.clerkDomain ?? null).toBe(domain);
      expect(script.onerror).toStrictEqual(expect.any(Function));
      expect(script.onload).toStrictEqual(expect.any(Function));
      expect(script.type).toBe("text/javascript");
      expect(bootstrap.publishableKey).toBe(publishableKey);
      expect(bootstrap.productionPrimaryAppDomain).toBe(
        productionPrimaryAppDomain ?? CURRENT_PRIMARY_APP_DOMAIN,
      );
      expect(bootstrap.domain ?? null).toBe(domain);
      expect(bootstrap.loadOptions).toStrictEqual({
        afterSignOutUrl: `${authOrigin}/sign-in`,
        ...(domain ? { isSatellite: true, satelliteAutoSync: true } : {}),
        signInUrl: `${authOrigin}/sign-in`,
        signUpUrl: `${authOrigin}/sign-up`,
      });
    },
  );

  it("starts Clerk.load before application bootstrap and adopts the same promise", async () => {
    const loadCanFinish = context.mocks.deferred<void>();
    mockedClerkLoad.mockReturnValue(loadCanFinish.promise);
    const script = captureClerkBootstrapScript("https://pr-30199-app.omby.ai/");

    Reflect.set(globalThis, "Clerk", mockedClerk);
    script.dispatchEvent(new Event("load"));

    const bootstrap = window.__vm0ClerkBootstrap;
    if (!bootstrap?.loaded || !bootstrap.onboardingStatusPromise) {
      throw new Error("Clerk bootstrap did not start its shared promises");
    }
    const startedAt = bootstrap.clerkLoadStartedAt;
    expect(startedAt).toStrictEqual(expect.any(Number));
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
    expect(bootstrap.loaded).toBe(loadCanFinish.promise);
    const onboardingStatusPromise = bootstrap.onboardingStatusPromise;
    script.dispatchEvent(new Event("load"));
    expect(bootstrap.onboardingStatusPromise).toBe(onboardingStatusPromise);
    expect(mockedClerkLoad).toHaveBeenCalledOnce();

    const setup = setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });
    expect(mockedClerkLoad).toHaveBeenCalledOnce();

    loadCanFinish.resolve(undefined);
    await Promise.all([setup, bootstrap.onboardingStatusPromise]);

    const completedAt = bootstrap.clerkLoadCompletedAt;
    expect(completedAt).toStrictEqual(expect.any(Number));
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
    expect(
      performance.getEntriesByName(CLERK_LOAD_STARTED_MARK, "mark")[0]
        ?.startTime,
    ).toBe(startedAt);
    expect(
      performance.getEntriesByName(CLERK_LOAD_COMPLETED_MARK, "mark")[0]
        ?.startTime,
    ).toBe(completedAt);
  });

  it("does not start onboarding after a final pagehide during Clerk.load", async () => {
    clearMockedAuthOnAbort(context.signal);
    const loadCanFinish = context.mocks.deferred<void>();
    mockedClerkLoad.mockReturnValue(loadCanFinish.promise);
    let requests = 0;
    context.mocks.http.get("*/api/onboarding/status", () => {
      requests += 1;
      return HttpResponse.json(PREFETCHED_ONBOARDING_STATUS);
    });
    const script = captureClerkBootstrapScript("https://pr-30199-app.omby.ai/");

    Reflect.set(globalThis, "Clerk", mockedClerk);
    script.dispatchEvent(new Event("load"));
    const bootstrap = window.__vm0ClerkBootstrap;
    if (!bootstrap?.onboardingStatusPromise) {
      throw new Error("Clerk bootstrap did not start onboarding ownership");
    }

    window.dispatchEvent(new Event("pagehide"));
    loadCanFinish.resolve(undefined);

    await expect(bootstrap.onboardingStatusPromise).resolves.toBeNull();
    expect(mockedClerk.sessionGetToken).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it("merges the in-flight core script without a second Clerk.load", async () => {
    const harness = startClerkPage();

    expect(mockedClerkLoad).not.toHaveBeenCalled();
    await completeEarlyClerkScript(harness);

    expect(harness.requests.map(({ url }) => url)).toStrictEqual([
      expectedClerkScriptUrl(),
    ]);
    expect(document.querySelectorAll(CLERK_SCRIPT_SELECTOR)).toHaveLength(1);
    expect(document.querySelector("script[data-clerk-ui-script]")).toBeNull();
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
  });

  it.each([
    {
      apiOriginMarker: undefined,
      authOrigin: "https://pr-30199-app.omby.ai",
      bypass: "preview-secret",
      cookie: "x-vercel-protection-bypass=preview-secret",
      domain: null,
      expectedRequestUrl: "https://pr-30199-api.vm6.ai/api/onboarding/status",
      expectedScriptUrl: expectedClerkScriptUrl(),
      url: "https://pr-30199-app.omby.ai/",
    },
    {
      apiOriginMarker: undefined,
      authOrigin: "https://app.vm0.ai",
      bypass: null,
      cookie: undefined,
      domain: null,
      expectedRequestUrl: "https://api.vm0.ai/api/onboarding/status",
      expectedScriptUrl: expectedClerkScriptUrl(),
      url: "https://app.vm0.ai/",
    },
    {
      apiOriginMarker: undefined,
      authOrigin: "https://app.vm0.ai",
      bypass: null,
      cookie: undefined,
      domain: "app.okou.ai",
      expectedRequestUrl: "https://api.okou.ai/api/onboarding/status",
      expectedScriptUrl: expectedClerkScriptUrl(),
      url: "https://app.okou.ai/",
    },
    {
      apiOriginMarker: "https://pr-30199-api.vm6.ai",
      authOrigin: "https://pr-30199.okou-app.pages.dev",
      bypass: null,
      cookie: undefined,
      domain: null,
      expectedRequestUrl: "https://pr-30199-api.vm6.ai/api/onboarding/status",
      expectedScriptUrl: expectedClerkScriptUrl(),
      url: "https://pr-30199.okou-app.pages.dev/",
    },
  ])(
    "prefetches onboarding with the authenticated $url configuration",
    async ({
      apiOriginMarker,
      authOrigin,
      bypass,
      cookie,
      domain,
      expectedRequestUrl,
      expectedScriptUrl,
      url,
    }) => {
      const requests: Request[] = [];
      context.mocks.http.get("*/api/onboarding/status", ({ request }) => {
        requests.push(request);
        return HttpResponse.json(PREFETCHED_ONBOARDING_STATUS);
      });
      const harness = startClerkPage({
        apiOriginMarker,
        cookie,
        url,
      });

      await completeEarlyClerkScript(harness);

      expect(harness.requests.map((request) => request.url)).toStrictEqual([
        expectedScriptUrl,
      ]);
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (!request) {
        throw new Error("Onboarding prefetch did not issue a request");
      }
      expect(request.url).toBe(expectedRequestUrl);
      expect(request.credentials).toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      expect(request.headers.get("x-client-type")).toBe("App");
      expect(request.headers.get("x-client-version")).toBe(TEST_APP_VERSION);
      expect(request.headers.get("x-client-session-id")).toMatch(
        /^[0-9a-f-]{36}$/u,
      );
      expect(request.headers.get("x-client-request-id")).toMatch(
        /^[0-9a-f-]{36}$/u,
      );
      expect(request.headers.get("x-vercel-protection-bypass")).toBe(bypass);
      expect(mockedClerkLoad).toHaveBeenCalledWith(
        expect.objectContaining({
          afterSignOutUrl: `${authOrigin}/sign-in`,
          ...(domain ? { isSatellite: true, satelliteAutoSync: true } : {}),
          signInUrl: `${authOrigin}/sign-in`,
          signUpUrl: `${authOrigin}/sign-up`,
        }),
      );
    },
  );

  it("reuses the in-flight onboarding result without a second request", async () => {
    const requestStarted = context.mocks.deferred<void>();
    const requestCanFinish = context.mocks.deferred<void>();
    let requests = 0;
    context.mocks.http.get("*/api/onboarding/status", async () => {
      requests += 1;
      requestStarted.resolve(undefined);
      await requestCanFinish.promise;
      return HttpResponse.json(PREFETCHED_ONBOARDING_STATUS);
    });
    const harness = startClerkPage();

    await loadEarlyClerkScript(harness);
    await requestStarted.promise;
    const onboardingStatus = context.store.get(onboardingStatus$);

    expect(requests).toBe(1);
    requestCanFinish.resolve(undefined);
    await expect(onboardingStatus).resolves.toStrictEqual(
      PREFETCHED_ONBOARDING_STATUS,
    );
    await harness.setup;
    expect(requests).toBe(1);
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
  });

  it("settles early ownership when aborted during the Clerk token read", async () => {
    const tokenReadStarted = context.mocks.deferred<void>();
    const tokenReadCanFinish = context.mocks.deferred<string>();
    let observedTokenRead = false;
    mockedClerk.sessionGetToken.mockImplementation((options) => {
      if (options?.skipCache) {
        return Promise.resolve("fresh-test-token");
      }
      if (!observedTokenRead) {
        observedTokenRead = true;
        tokenReadStarted.resolve(undefined);
      }
      return tokenReadCanFinish.promise;
    });
    let requests = 0;
    context.mocks.http.get("*/api/onboarding/status", () => {
      requests += 1;
      return HttpResponse.json(PREFETCHED_ONBOARDING_STATUS);
    });
    const harness = startClerkPage();

    await loadEarlyClerkScript(harness);
    await tokenReadStarted.promise;
    const bootstrap = window.__vm0ClerkBootstrap;
    if (!bootstrap?.onboardingStatusPromise) {
      throw new Error("Clerk bootstrap did not start onboarding ownership");
    }
    bootstrap.abortOnboarding();

    await expect(bootstrap.onboardingStatusPromise).resolves.toBeNull();
    expect(requests).toBe(0);
    tokenReadCanFinish.resolve("test-token");
    await harness.setup;
    expect(requests).toBe(0);
  });

  it("falls through to existing auth recovery after an early request failure", async () => {
    const authorizations: (string | null)[] = [];
    context.mocks.http.get("*/api/onboarding/status", ({ request }) => {
      authorizations.push(request.headers.get("authorization"));
      if (authorizations.length < 3) {
        return HttpResponse.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Unauthorized",
            },
          },
          { status: 401 },
        );
      }
      return HttpResponse.json(RETRIED_ONBOARDING_STATUS);
    });
    mockedClerk.sessionGetToken.mockImplementation((options) => {
      return Promise.resolve(
        options?.skipCache ? "fresh-test-token" : "stale-test-token",
      );
    });
    const harness = startClerkPage();

    await completeEarlyClerkScript(harness);
    const forcedTokenReadsBeforeRetry =
      mockedClerk.sessionGetToken.mock.calls.filter(([options]) => {
        return options?.skipCache === true;
      }).length;
    await expect(context.store.get(onboardingStatus$)).resolves.toStrictEqual(
      RETRIED_ONBOARDING_STATUS,
    );

    expect(authorizations).toStrictEqual([
      "Bearer stale-test-token",
      "Bearer stale-test-token",
      "Bearer fresh-test-token",
    ]);
    expect(
      mockedClerk.sessionGetToken.mock.calls.filter(([options]) => {
        return options?.skipCache === true;
      }),
    ).toHaveLength(forcedTokenReadsBeforeRetry + 1);
  });

  it.each([
    {
      identity: "organization",
      switchIdentity: () => {
        mockOrganization({
          activeOrg: { id: "org_next", name: "Next Org" },
          memberships: [{ id: "org_next" }],
        });
      },
    },
    {
      identity: "session",
      switchIdentity: () => {
        mockUser(
          {
            clientSessions: [
              {
                id: "next-session-id",
                status: "pending",
                user: { fullName: "Test User" },
              },
            ],
            fullName: "Test User",
            id: "test-user-123",
          },
          { token: "next-test-token" },
        );
      },
    },
  ])(
    "rejects a stale in-flight result after an $identity switch",
    async ({ switchIdentity }) => {
      const firstRequestStarted = context.mocks.deferred<void>();
      const firstRequestCanFinish = context.mocks.deferred<void>();
      let requests = 0;
      context.mocks.http.get("*/api/onboarding/status", async () => {
        requests += 1;
        if (requests === 1) {
          firstRequestStarted.resolve(undefined);
          await firstRequestCanFinish.promise;
          return HttpResponse.json(PREFETCHED_ONBOARDING_STATUS);
        }
        return HttpResponse.json(RETRIED_ONBOARDING_STATUS);
      });
      const harness = startClerkPage();

      await loadEarlyClerkScript(harness);
      await firstRequestStarted.promise;
      const onboardingStatus = context.store.get(onboardingStatus$);
      switchIdentity();
      firstRequestCanFinish.resolve(undefined);

      await expect(onboardingStatus).resolves.toStrictEqual(
        RETRIED_ONBOARDING_STATUS,
      );
      await harness.setup;
      expect(requests).toBe(2);
    },
  );

  it("keeps platform-owned auth routes on the Clerk core runtime", async () => {
    const harness = startClerkPage({ path: "/sign-in" });

    await completeEarlyClerkScript(harness);

    expect(harness.requests.map(({ url }) => url)).toStrictEqual([
      expectedClerkScriptUrl(),
    ]);
    expect(document.querySelector("script[data-clerk-ui-script]")).toBeNull();
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
  });

  it("falls back immediately when the bootstrap request fails", async () => {
    const harness = startClerkPage();
    await harness.clerkLoaderWatchingEarlyScript;

    harness.earlyScript.dispatchEvent(new Event("error"));
    await harness.retryStarted;
    await harness.setup;

    expect(harness.earlyScript.isConnected).toBeFalsy();
    expect(harness.requests.map(({ url }) => url)).toStrictEqual([
      expectedClerkScriptUrl(),
      expectedFallbackClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
    ]);
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
  });
});
