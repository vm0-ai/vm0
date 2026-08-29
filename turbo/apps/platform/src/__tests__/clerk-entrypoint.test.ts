import { describe, expect, it, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import { setupPage } from "./page-helper.ts";
import { mockedClerk, mockedClerkLoad } from "./mock-auth.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

vi.unmock("@clerk/shared/loadClerkJsScript");

const CLERK_JS_VERSION = "6.25.8";
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
  readonly setup: Promise<void>;
}

type ClerkEntrypointScript = (
  windowObject: Window,
  documentObject: Document,
  locationObject: Location,
  atobFunction: typeof atob,
) => void;

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

function clerkEntrypointSource(): string {
  const source = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/giu)]
    .map((match) => {
      return match[1];
    })
    .find((script) => {
      return script?.includes('s.setAttribute("data-clerk-js-script", "")');
    });
  if (source === undefined) {
    throw new Error("Unable to locate the Clerk loader in index.html");
  }
  return source
    .replaceAll("%VITE_CLERK_PUBLISHABLE_KEY_PREVIEW%", PREVIEW_PUBLISHABLE_KEY)
    .replaceAll(
      "%VITE_CLERK_PUBLISHABLE_KEY_PROD%",
      PRODUCTION_PUBLISHABLE_KEY,
    );
}

function expectedClerkScriptUrl(host: string): string {
  return `https://${host}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`;
}

function startClerkPage(hostname: string): ClerkEntrypointHarness {
  const requests: ClerkScriptRequest[] = [];
  const clerkLoaderWatchingEarlyScript = context.mocks.deferred<void>();
  let earlyScript: HTMLScriptElement | undefined;

  const setup = setupPage({
    beforeBootstrap: (signal) => {
      context.mocks.browser.url(`https://${hostname}/`);
      const previousPreviewKey = import.meta.env
        .VITE_CLERK_PUBLISHABLE_KEY_PREVIEW;
      const previousProductionKey = import.meta.env
        .VITE_CLERK_PUBLISHABLE_KEY_PROD;
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PREVIEW", PREVIEW_PUBLISHABLE_KEY);
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY_PROD", PRODUCTION_PUBLISHABLE_KEY);
      window.__vm0BrowserSupported = true;
      Reflect.deleteProperty(globalThis, "Clerk");

      const observeScript = (
        append: typeof document.head.appendChild,
        node: Node,
      ): Node => {
        if (!(node instanceof HTMLScriptElement) || !node.src) {
          return append(node);
        }

        const request = { element: node, url: node.src };
        requests.push(request);
        // Keep Happy DOM from making an external request. The real Clerk
        // loader still observes the connected data-clerk-js-script element.
        node.removeAttribute("src");
        const appended = append(node);

        if (requests.length > 1) {
          Reflect.set(globalThis, "Clerk", mockedClerk);
          node.dispatchEvent(new Event("load"));
        }
        return appended;
      };

      const appendToHead = document.head.appendChild.bind(document.head);
      vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
        return observeScript(appendToHead, node);
      });
      const appendToBody = document.body.appendChild.bind(document.body);
      vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
        return observeScript(appendToBody, node);
      });

      const executeEntrypointScript = new Function(
        "window",
        "document",
        "location",
        "atob",
        `${clerkEntrypointSource()}\n//# sourceURL=platform-clerk-entrypoint-test.js`,
      ) as ClerkEntrypointScript;
      executeEntrypointScript(window, document, location, atob);

      earlyScript = document.querySelector(CLERK_SCRIPT_SELECTOR) ?? undefined;
      if (!earlyScript) {
        throw new Error("Clerk entrypoint did not append its core script");
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
  it("starts the preview Clerk core request with the official attributes", async () => {
    const harness = startClerkPage("pr-30199-app.omby.ai");

    expect(mockedClerkLoad).not.toHaveBeenCalled();
    await completeEarlyClerkScript(harness);

    expect(harness.requests.map(({ url }) => url)).toStrictEqual([
      expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
    ]);
    expect(harness.earlyScript.async).toBeTruthy();
    expect(harness.earlyScript.crossOrigin).toBe("anonymous");
    expect(harness.earlyScript).toHaveAttribute("data-clerk-js-script", "");
    expect(harness.earlyScript).toHaveAttribute(
      "data-clerk-publishable-key",
      PREVIEW_PUBLISHABLE_KEY,
    );
    expect(harness.earlyScript).not.toHaveAttribute("data-clerk-domain");
    expect(mockedClerkLoad).toHaveBeenCalledOnce();
  });

  it("uses the production Frontend API host without a satellite domain", async () => {
    const harness = startClerkPage("app.vm0.ai");

    await completeEarlyClerkScript(harness);

    expect(harness.requests.map(({ url }) => url)).toStrictEqual([
      expectedClerkScriptUrl(PRODUCTION_FRONTEND_API_HOST),
    ]);
    expect(harness.earlyScript).toHaveAttribute(
      "data-clerk-publishable-key",
      PRODUCTION_PUBLISHABLE_KEY,
    );
    expect(harness.earlyScript).not.toHaveAttribute("data-clerk-domain");
  });

  it("uses Clerk's satellite script host and domain on app.okou.ai", async () => {
    const harness = startClerkPage(PRODUCTION_SATELLITE_DOMAIN);

    await completeEarlyClerkScript(harness);

    expect(harness.requests.map(({ url }) => url)).toStrictEqual([
      expectedClerkScriptUrl(`clerk.${PRODUCTION_SATELLITE_DOMAIN}`),
    ]);
    expect(harness.earlyScript).toHaveAttribute(
      "data-clerk-publishable-key",
      PRODUCTION_PUBLISHABLE_KEY,
    );
    expect(harness.earlyScript).toHaveAttribute(
      "data-clerk-domain",
      PRODUCTION_SATELLITE_DOMAIN,
    );
  });

  it("retries immediately after the early request fails", async () => {
    const harness = startClerkPage("pr-30199-app.omby.ai");
    await harness.clerkLoaderWatchingEarlyScript;
    harness.earlyScript.dispatchEvent(new Event("error"));
    await harness.setup;

    expect(harness.earlyScript.isConnected).toBeFalsy();
    expect(harness.requests.map(({ url }) => url)).toStrictEqual([
      expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
      expectedClerkScriptUrl(PREVIEW_FRONTEND_API_HOST),
    ]);
  });
});
