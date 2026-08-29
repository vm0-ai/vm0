import { describe, expect, it, vi } from "vitest";

import indexHtml from "../../index.html?raw";
import { transformClerkCoreScriptUrls } from "../../scripts/clerk-html.ts";
import { CLERK_JS_VERSION } from "../lib/clerk-versions.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";
import { mockedClerk, mockedClerkLoad } from "./mock-auth.ts";
import { setupPage } from "./page-helper.ts";

vi.unmock("@clerk/shared/loadClerkJsScript");

const PREVIEW_FRONTEND_API_HOST = "informed-calf-6.clerk.accounts.dev";
const PRODUCTION_FRONTEND_API_HOST = "clerk.vm0.ai";
const PRODUCTION_SATELLITE_DOMAIN = "app.okou.ai";
const CLERK_SCRIPT_SELECTOR = "script[data-clerk-js-script]";

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

function clerkScriptFromHtml(html: string): HTMLScriptElement {
  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  const script = parsedDocument.querySelector(CLERK_SCRIPT_SELECTOR);
  if (!(script instanceof HTMLScriptElement)) {
    throw new Error("Built index.html does not contain the Clerk core script");
  }
  return script;
}

function startClerkPage(): ClerkEntrypointHarness {
  const requests: ClerkScriptRequest[] = [];
  const clerkLoaderWatchingEarlyScript = context.mocks.deferred<void>();
  const retryStarted = context.mocks.deferred<void>();
  let earlyScript: HTMLScriptElement | undefined;

  const setup = setupPage({
    beforeBootstrap: (signal) => {
      context.mocks.browser.url("https://pr-30199-app.omby.ai/");
      const previousPreviewKey = import.meta.env
        .VITE_CLERK_PUBLISHABLE_KEY_PREVIEW;
      const previousProductionKey = import.meta.env
        .VITE_CLERK_PUBLISHABLE_KEY_PROD;
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PREVIEW", PREVIEW_PUBLISHABLE_KEY);
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PROD", PRODUCTION_PUBLISHABLE_KEY);
      window.__vm0BrowserSupported = true;
      Reflect.deleteProperty(globalThis, "Clerk");

      const parsedEarlyScript = clerkScriptFromHtml(builtIndexHtml());
      const earlyScriptUrl = parsedEarlyScript.src;
      parsedEarlyScript.removeAttribute("src");
      document.head.appendChild(parsedEarlyScript);
      requests.push({ element: parsedEarlyScript, url: earlyScriptUrl });
      parsedEarlyScript.addEventListener("error", () => {
        if (parsedEarlyScript.getAttribute("onerror") === "this.remove()") {
          parsedEarlyScript.remove();
        }
      });

      const addEventListener =
        parsedEarlyScript.addEventListener.bind(parsedEarlyScript);
      vi.spyOn(parsedEarlyScript, "addEventListener").mockImplementation(
        (type, listener, options) => {
          if (type === "error") {
            clerkLoaderWatchingEarlyScript.resolve(undefined);
          }
          addEventListener(type, listener, options);
        },
      );

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

      earlyScript = parsedEarlyScript;
      signal.addEventListener(
        "abort",
        () => {
          headAppendSpy.mockRestore();
          bodyAppendSpy.mockRestore();
          for (const request of requests) {
            request.element.remove();
          }
          Reflect.deleteProperty(globalThis, "Clerk");
          Reflect.deleteProperty(window, "__vm0BrowserSupported");
          vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PREVIEW", previousPreviewKey);
          vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PROD", previousProductionKey);
        },
        { once: true },
      );
    },
    context,
    path: "/error",
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
  it("builds the official static core script with exact environment URLs", () => {
    const html = builtIndexHtml();
    const script = clerkScriptFromHtml(html);
    const parsedDocument = new DOMParser().parseFromString(html, "text/html");

    expect(parsedDocument.querySelectorAll(CLERK_SCRIPT_SELECTOR)).toHaveLength(
      1,
    );
    expect(
      html.indexOf(expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST)),
    ).toBeLessThan(
      html.indexOf('<script type="module" src="/src/main.ts"></script>'),
    );
    expect(script.src).toBe(expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST));
    expect(script.defer).toBeTruthy();
    expect(script.async).toBeFalsy();
    expect(script.crossOrigin).toBe("anonymous");
    expect(script).toHaveAttribute("data-clerk-js-script", "");
    expect(script).toHaveAttribute(
      "data-clerk-publishable-key",
      PREVIEW_PUBLISHABLE_KEY,
    );
    expect(script).toHaveAttribute(
      "data-vm0-clerk-production-publishable-key",
      PRODUCTION_PUBLISHABLE_KEY,
    );
    expect(script).toHaveAttribute(
      "data-vm0-clerk-production-script-url",
      expectedClerkScriptUrl(PRODUCTION_FRONTEND_API_HOST),
    );
    expect(script).toHaveAttribute(
      "data-vm0-clerk-satellite-script-url",
      expectedClerkScriptUrl(`clerk.${PRODUCTION_SATELLITE_DOMAIN}`),
    );
    expect(script).toHaveAttribute("onerror", "this.remove()");
    expect(script.textContent).toBe("");
    expect(html).not.toContain("@clerk/ui");
  });

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

  it("falls back immediately when the static request fails", async () => {
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
