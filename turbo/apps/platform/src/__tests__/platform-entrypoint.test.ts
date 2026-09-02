import { waitFor } from "@testing-library/react";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import INDEX_HTML from "../../index.html?raw";
import { startPlatformEntrypoint } from "../lib/platform-entrypoint.ts";
import { setFeatureSwitchLocalStorage$ } from "../signals/external/feature-switch-state.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();
const BOOTSTRAP_CONTENT_SELECTOR = ".app-bootstrap-skeleton__content";
const INSTATUS_WIDGET_HOSTNAME = "api.dashboard.instatus.com";
const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";

let googleAdsRequestedAfterApplicationStart = false;

function requiredIndexElement(id: string): HTMLElement {
  const sourceDocument = new DOMParser().parseFromString(
    INDEX_HTML,
    "text/html",
  );
  const element = sourceDocument.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing #${id} in the Platform index`);
  }
  return element;
}

function setupPlatformDocument(): HTMLElement {
  const criticalStyles = requiredIndexElement("app-bootstrap-critical-styles");
  const root = requiredIndexElement("root");
  const skeleton = requiredIndexElement("app-bootstrap-skeleton");
  document.getElementById("app-bootstrap-critical-styles")?.remove();
  for (const link of document.querySelectorAll(
    'link[rel="apple-touch-startup-image"]',
  )) {
    link.remove();
  }
  document.head.append(criticalStyles.cloneNode(true));
  document.body.replaceChildren(root.cloneNode(true), skeleton.cloneNode(true));
  document.documentElement.dataset.theme = "dark";

  const avatar = document.querySelector(".app-bootstrap-skeleton__avatar");
  if (!(avatar instanceof HTMLElement)) {
    throw new Error("Missing bootstrap avatar in the Platform index");
  }
  return avatar;
}

function setStartupImageFeatureSwitch(enabled: boolean): void {
  const switches = getAllFeatureStates({});
  switches[FeatureSwitchKey.IosPwaStartupImages] = enabled;
  context.store.set(setFeatureSwitchLocalStorage$, JSON.stringify(switches));
}

function instatusScripts(): HTMLScriptElement[] {
  return Array.from(document.scripts).filter((script) => {
    const source = script.getAttribute("src");
    if (!source) {
      return false;
    }
    return (
      new URL(source, window.location.href).hostname ===
      INSTATUS_WIDGET_HOSTNAME
    );
  });
}

async function waitForApplicationStart(): Promise<void> {
  await waitFor(() => {
    expect(document.getElementById("root")?.childElementCount).toBeGreaterThan(
      0,
    );
  });
}

async function stopApplication(): Promise<void> {
  window.dispatchEvent(new Event("pagehide"));
  await waitFor(() => {
    expect(document.querySelector(".zero-app")).toBeNull();
  });
}

describe("platform entrypoint", () => {
  beforeEach(async () => {
    googleAdsRequestedAfterApplicationStart = false;
    context.mocks.browser.url("https://app.vm0.ai/");
    context.mocks.clerk();
    context.mocks.posthog();
    context.mocks.sentry();
    setupPlatformDocument();

    const addEventListener = vi.spyOn(window, "addEventListener");
    const appendChild = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation(
      <T extends Node>(node: T): T => {
        if (
          node instanceof HTMLScriptElement &&
          node.src === GOOGLE_TAG_SCRIPT_URL
        ) {
          googleAdsRequestedAfterApplicationStart =
            addEventListener.mock.calls.some(([eventName]) => {
              return eventName === "pagehide";
            });
        }
        return appendChild(node);
      },
    );

    startPlatformEntrypoint();
    await waitForApplicationStart();
  });

  afterEach(stopApplication);

  it("does not inject the Instatus widget", () => {
    expect(instatusScripts()).toStrictEqual([]);
  });

  it("starts the application before requesting Google Ads", () => {
    expect(googleAdsRequestedAfterApplicationStart).toBeTruthy();
  });
});

describe("iOS PWA startup image entrypoint", () => {
  let portraitOrientation = true;

  beforeEach(() => {
    portraitOrientation = true;
    context.mocks.browser.url("https://app.vm0.ai/");
    context.mocks.browser.userAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    );
    context.mocks.browser.platform("iPhone");
    context.mocks.browser.maxTouchPoints(5);
    context.mocks.browser.screen({ height: 874, pixelRatio: 3, width: 402 });
    context.mocks.browser.matchMedia((query) => {
      return (
        query === "(prefers-color-scheme: dark)" ||
        (query === "(orientation: portrait)" && portraitOrientation)
      );
    });
    context.mocks.clerk();
    context.mocks.posthog();
    context.mocks.sentry();
  });

  afterEach(stopApplication);

  it("keeps startup image generation disabled behind its feature switch", async () => {
    const avatar = setupPlatformDocument();
    setStartupImageFeatureSwitch(false);

    startPlatformEntrypoint();

    await waitFor(() => {
      expect(getComputedStyle(avatar).animationPlayState).toBe("running");
    });
    expect(
      document.querySelectorAll('link[rel="apple-touch-startup-image"]'),
    ).toHaveLength(0);
    await waitForApplicationStart();
  });

  it("generates startup images through the production entrypoint when enabled", async () => {
    const avatar = setupPlatformDocument();
    const content = document.querySelector(BOOTSTRAP_CONTENT_SELECTOR);
    if (!(content instanceof HTMLElement)) {
      throw new Error("Missing bootstrap content in the Platform index");
    }
    const image = context.mocks.browser.imageDimensions({
      height: 480,
      width: 480,
    });
    const canvas = context.mocks.browser.canvasRendering();
    setStartupImageFeatureSwitch(true);

    startPlatformEntrypoint();

    expect(getComputedStyle(avatar).animationPlayState).toBe("paused");
    expect(content.style.top).toBe("437px");
    await waitFor(() => {
      expect(
        document.querySelectorAll('link[rel="apple-touch-startup-image"]'),
      ).toHaveLength(2);
    });

    const links = [
      ...document.querySelectorAll<HTMLLinkElement>(
        'link[rel="apple-touch-startup-image"]',
      ),
    ];
    expect(getComputedStyle(avatar).animationPlayState).toBe("running");
    expect(canvas.renders).toStrictEqual([
      {
        avatar: {
          centerX: 603,
          centerY: 1311,
          clipRadius: 96,
          height: 240,
          width: 240,
          x: 483,
          y: 1191,
        },
        background: "#19191b",
        height: 2622,
        width: 1206,
      },
      {
        avatar: {
          centerX: 1311,
          centerY: 603,
          clipRadius: 96,
          height: 240,
          width: 240,
          x: 1191,
          y: 483,
        },
        background: "#19191b",
        height: 1206,
        width: 2622,
      },
    ]);
    expect(
      links.map((link) => {
        return { href: link.getAttribute("href"), media: link.media };
      }),
    ).toStrictEqual([
      {
        href: "data:image/png;base64,AAAA",
        media: "screen and (orientation: portrait)",
      },
      {
        href: "data:image/png;base64,AAAB",
        media: "screen and (orientation: landscape)",
      },
    ]);
    expect(image.revokedUrls).toStrictEqual(["blob:mock-image-1"]);
    await waitForApplicationStart();
  });

  it("pins the bootstrap skeleton to the landscape startup image center", async () => {
    portraitOrientation = false;
    setupPlatformDocument();
    const content = document.querySelector(BOOTSTRAP_CONTENT_SELECTOR);
    if (!(content instanceof HTMLElement)) {
      throw new Error("Missing bootstrap content in the Platform index");
    }
    context.mocks.browser.imageDimensions({ height: 480, width: 480 });
    context.mocks.browser.canvasRendering();
    setStartupImageFeatureSwitch(true);

    startPlatformEntrypoint();

    expect(content.style.top).toBe("201px");
    await waitFor(() => {
      expect(
        document.querySelectorAll('link[rel="apple-touch-startup-image"]'),
      ).toHaveLength(2);
    });
  });
});
