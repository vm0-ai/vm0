import { describe, expect, it, vi } from "vitest";

import indexHtml from "../../index.html?raw";
import { transformClerkCoreScriptUrls } from "../../scripts/clerk-html-transform.ts";
import { CLERK_JS_VERSION } from "../lib/clerk-versions.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";
import { mockedClerk, mockedClerkLoad } from "./mock-auth.ts";
import { setupPage } from "./page-helper.ts";

vi.unmock("@clerk/shared/loadClerkJsScript");

const PREVIEW_FRONTEND_API_HOST = "informed-calf-6.clerk.accounts.dev";
const PRODUCTION_FRONTEND_API_HOST = "clerk.vm0.ai";
const PRODUCTION_SATELLITE_DOMAIN = "app.okou.ai";
const CLERK_BOOTSTRAP_SELECTOR = "script[data-vm0-clerk-bootstrap]";
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

function expectedClerkScriptUrl(host: string): string {
  return `https://${host}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`;
}

function expectedClerkUiScriptUrl(host: string): string {
  return `https://${host}/npm/@clerk/ui@1.26.0/dist/ui.browser.js`;
}

function builtIndexHtml(): string {
  return transformClerkCoreScriptUrls(
    indexHtml
      .replaceAll(
        "%VITE_CLERK_PUBLISHABLE_KEY_PREVIEW%",
        PREVIEW_PUBLISHABLE_KEY,
      )
      .replaceAll(
        "%VITE_CLERK_PUBLISHABLE_KEY_PROD%",
        PRODUCTION_PUBLISHABLE_KEY,
      ),
    {
      previewPublishableKey: PREVIEW_PUBLISHABLE_KEY,
      productionPublishableKey: PRODUCTION_PUBLISHABLE_KEY,
    },
  );
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

function captureClerkBootstrapScript(url: string): HTMLScriptElement {
  context.mocks.browser.url(url);
  let clerkScript: HTMLScriptElement | undefined;
  const appendSpy = vi
    .spyOn(document.head, "appendChild")
    .mockImplementation(<T extends Node>(node: T): T => {
      if (
        node instanceof HTMLScriptElement &&
        node.dataset.clerkJsScript !== undefined
      ) {
        clerkScript = node;
      }
      return node;
    });

  executeClerkBootstrap(builtIndexHtml());
  appendSpy.mockRestore();
  if (!clerkScript) {
    throw new Error("Clerk bootstrap did not create the core script");
  }
  return clerkScript;
}

function startClerkPage(path = "/error"): ClerkEntrypointHarness {
  const requests: ClerkScriptRequest[] = [];
  const clerkLoaderWatchingEarlyScript = context.mocks.deferred<void>();
  const retryStarted = context.mocks.deferred<void>();
  let earlyScript: HTMLScriptElement | undefined;

  const setup = setupPage({
    beforeBootstrap: (signal) => {
      context.mocks.browser.url("https://pr-30199-app.omby.ai/");
      window.__vm0BrowserSupported = true;
      Reflect.deleteProperty(globalThis, "Clerk");
      Reflect.deleteProperty(globalThis, "__internal_ClerkUICtor");

      const observeScript = (
        append: typeof document.body.appendChild,
        node: Node,
      ): Node => {
        if (!(node instanceof HTMLScriptElement) || !node.src) {
          return append(node);
        }

        requests.push({ element: node, url: node.src });
        const isClerkUiRequest = node.src.includes("/npm/@clerk/ui@");
        node.removeAttribute("src");
        const appended = append(node);
        if (
          earlyScript === undefined &&
          node.dataset.clerkJsScript !== undefined
        ) {
          earlyScript = node;
          return appended;
        }
        if (isClerkUiRequest) {
          Reflect.set(
            globalThis,
            "__internal_ClerkUICtor",
            function ClerkUI() {},
          );
        } else {
          retryStarted.resolve(undefined);
          Reflect.set(globalThis, "Clerk", mockedClerk);
        }
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

      executeClerkBootstrap(builtIndexHtml());
      if (!earlyScript) {
        throw new Error("Clerk bootstrap did not run synchronously");
      }
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
          for (const request of requests) {
            request.element.remove();
          }
          Reflect.deleteProperty(globalThis, "Clerk");
          Reflect.deleteProperty(globalThis, "__internal_ClerkUICtor");
          Reflect.deleteProperty(window, "__vm0BrowserSupported");
        },
        { once: true },
      );
    },
    context,
    path,
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

async function completeEarlyClerkScript(
  harness: ClerkEntrypointHarness,
): Promise<void> {
  await harness.clerkLoaderWatchingEarlyScript;
  Reflect.set(globalThis, "Clerk", mockedClerk);
  harness.earlyScript.dispatchEvent(new Event("load"));
  await harness.setup;
}

describe("platform Clerk entrypoint", () => {
  it("declares the Clerk bootstrap before the app module", () => {
    const html = builtIndexHtml();
    const parsedDocument = new DOMParser().parseFromString(html, "text/html");
    const bootstrap = parsedDocument.querySelector(CLERK_BOOTSTRAP_SELECTOR);
    const mainScript = parsedDocument.querySelector(
      'script[type="module"][src="/src/main.ts"]',
    );
    if (!(bootstrap instanceof HTMLScriptElement)) {
      throw new Error("Built index.html does not contain the Clerk bootstrap");
    }
    if (!(mainScript instanceof HTMLScriptElement)) {
      throw new Error("Built index.html does not contain the app module");
    }

    expect(bootstrap.compareDocumentPosition(mainScript)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(html).not.toContain("@clerk/ui");
  });

  it.each([
    {
      domain: null,
      publishableKey: PREVIEW_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
      url: "https://pr-30199-app.omby.ai/",
    },
    {
      domain: null,
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(PRODUCTION_FRONTEND_API_HOST),
      url: "https://app.vm0.ai/",
    },
    {
      domain: PRODUCTION_SATELLITE_DOMAIN,
      publishableKey: PRODUCTION_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(`clerk.${PRODUCTION_SATELLITE_DOMAIN}`),
      url: "https://app.okou.ai/",
    },
    {
      domain: null,
      publishableKey: PREVIEW_PUBLISHABLE_KEY,
      scriptUrl: expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
      url: "https://okou.ai.evil.example/",
    },
  ])(
    "selects the Clerk core configuration on $url",
    ({ domain, publishableKey, scriptUrl, url }) => {
      const script = captureClerkBootstrapScript(url);

      expect(document.documentElement.dataset.vm0ClerkPublishableKey).toBe(
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
      expect(script.type).toBe("text/javascript");
    },
  );

  it("merges the in-flight script and lets TypeScript call Clerk.load", async () => {
    const harness = startClerkPage();

    expect(mockedClerkLoad).not.toHaveBeenCalled();
    await completeEarlyClerkScript(harness);

    expect(harness.requests.map(({ url }) => url)).toStrictEqual([
      expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
    ]);
    expect(document.querySelectorAll(CLERK_SCRIPT_SELECTOR)).toHaveLength(1);
    expect(document.querySelector("script[data-clerk-ui-script]")).toBeNull();
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
  });

  it("loads the matching Clerk UI release only when the auth route requests it", async () => {
    const harness = startClerkPage("/sign-in");

    await completeEarlyClerkScript(harness);

    expect(harness.requests.map(({ url }) => url)).toStrictEqual([
      expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
      expectedClerkUiScriptUrl(PREVIEW_FRONTEND_API_HOST),
    ]);
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
      expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
      expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
    ]);
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
  });
});
