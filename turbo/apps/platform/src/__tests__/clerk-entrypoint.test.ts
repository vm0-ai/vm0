import { describe, expect, it, vi } from "vitest";

import indexHtml from "../../index.html?raw";
import { transformClerkCoreScriptUrls } from "../../scripts/clerk-html-transform.ts";
import { CLERK_JS_VERSION } from "../lib/clerk-versions.ts";
import { resolvePlatformRuntimeConfig } from "../lib/platform-host.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";
import { mockedClerk, mockedClerkLoad } from "./mock-auth.ts";
import { setupPage } from "./page-helper.ts";

vi.unmock("@clerk/shared/loadClerkJsScript");

const PREVIEW_FRONTEND_API_HOST = "informed-calf-6.clerk.accounts.dev";
const PRODUCTION_FRONTEND_API_HOST = "clerk.vm0.ai";
const CURRENT_PRIMARY_APP_DOMAIN = "app.vm0.ai";
const CUTOVER_PRIMARY_APP_DOMAIN = "app.okou.ai";
const CLERK_BOOTSTRAP_SELECTOR = "script[data-vm0-clerk-bootstrap]";
const CLERK_CORE_SCRIPT_ID = "vm0-clerk-core-script";
const CLERK_SCRIPT_SELECTOR = "script[data-clerk-js-script]";

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
    "productionPublishableKey" | "productionPrimaryAppDomain"
  > = {},
): HTMLScriptElement {
  stubClerkBuildEnvironment(options.productionPublishableKey);
  context.mocks.browser.url(url);
  context.signal.addEventListener(
    "abort",
    () => {
      window.dispatchEvent(new Event("pagehide"));
      Reflect.deleteProperty(globalThis, "Clerk");
      Reflect.deleteProperty(window, "__vm0ClerkBootstrap");
    },
    { once: true },
  );
  const html = builtIndexHtml(
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
      context.mocks.browser.url(options.url ?? "https://pr-30199-app.omby.ai/");
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
    expect(fontStylesheet.parentElement).toBe(parsedDocument.head);
    expect(mainScript.parentElement).toBe(parsedDocument.head);
    expect(clerkCore.compareDocumentPosition(bootstrap)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(bootstrap.compareDocumentPosition(fontStylesheet)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(fontStylesheet.compareDocumentPosition(mainScript)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(mainScript.compareDocumentPosition(skeleton)).toBe(
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
    expect(criticalStyles.id).toBe("app-bootstrap-critical-styles");
    expect(externalSkeletonImages).toHaveLength(0);
    expect(inlineAvatar).toBeInstanceOf(SVGSVGElement);
    expect(inlineAvatar?.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(html).not.toContain("/assets/avatar-svg/");
    expect(skeleton).toHaveTextContent("");
    expect(fontStylesheet.rel).toBe("stylesheet");
    expect(fontStylesheet.hasAttribute("as")).toBeFalsy();
    expect(fontStylesheet.media).toBe("print");
    expect(fontStylesheet.hasAttribute("fetchpriority")).toBeFalsy();
    expect(fontStylesheet.getAttribute("onload")).toBe("this.media = 'all'");
    expect(mainScript.hasAttribute("fetchpriority")).toBeFalsy();
    expect(
      parsedDocument.querySelector(
        'link[rel="preconnect"][href*="fonts.googleapis.com"], link[rel="preconnect"][href*="fonts.gstatic.com"]',
      ),
    ).toBeNull();
    expect(
      parsedDocument.querySelector(
        'link[rel="preconnect"][href="https://cdn.vm0.io"], link[rel="preconnect"][href="https://static.vm0.io"]',
      ),
    ).toBeNull();
    expect(html.indexOf("data-vm0-clerk-bootstrap")).toBeLessThan(
      html.indexOf('type="module" src="/src/main.ts"'),
    );
    expect(html).not.toContain("@clerk/ui");
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
      authOrigin: "https://app.vm0.ai",
      domain: "app-worker.okou.ai",
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://app-worker.okou.ai/",
    },
    {
      authOrigin: "https://app-worker.vm0.ai",
      domain: null,
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://app-worker.vm0.ai/",
    },
    {
      authOrigin: "https://app-worker.okou.ai",
      domain: null,
      productionPrimaryAppDomain: CUTOVER_PRIMARY_APP_DOMAIN,
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://app-worker.okou.ai/",
    },
    {
      authOrigin: "https://app.okou.ai",
      domain: "vm0.ai",
      productionPrimaryAppDomain: CUTOVER_PRIMARY_APP_DOMAIN,
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(),
      url: "https://app-worker.vm0.ai/",
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
    if (!bootstrap?.loaded) {
      throw new Error("Clerk bootstrap did not start its shared promise");
    }
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
    expect(bootstrap.loaded).toBe(loadCanFinish.promise);
    const loaded = bootstrap.loaded;
    script.dispatchEvent(new Event("load"));
    expect(mockedClerkLoad).toHaveBeenCalledOnce();

    const setup = setupPage({
      context,
      path: "/error",
      withoutRender: true,
    });
    expect(mockedClerkLoad).toHaveBeenCalledOnce();

    loadCanFinish.resolve(undefined);
    await Promise.all([setup, loaded]);

    expect(bootstrap.loaded).toBeUndefined();
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
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
