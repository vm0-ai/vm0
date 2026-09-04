import { waitFor } from "@testing-library/react";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import INDEX_HTML from "../../index.html?raw";
import { startPlatformEntrypoint } from "../lib/platform-entrypoint.ts";
import { setFeatureSwitchLocalStorage$ } from "../signals/external/feature-switch-state.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();
const INSTATUS_WIDGET_HOSTNAME = "api.dashboard.instatus.com";
const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";
const RETIRED_PINNED_AGENT_STORAGE_KEYS = [
  "pinnedAgentGridRows",
  "vm0:pinned-agent-preview-cache:v1",
] as const;

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
    for (const key of RETIRED_PINNED_AGENT_STORAGE_KEYS) {
      localStorage.setItem(key, "retired");
    }

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

  it("removes retired pinned-agent storage", () => {
    for (const key of RETIRED_PINNED_AGENT_STORAGE_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });
});

describe("iOS PWA startup image entrypoint", () => {
  beforeEach(() => {
    context.mocks.browser.url("https://app.vm0.ai/");
    context.mocks.browser.userAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    );
    context.mocks.browser.platform("iPhone");
    context.mocks.browser.maxTouchPoints(5);
    context.mocks.browser.screen({ height: 852, pixelRatio: 3, width: 393 });
    context.mocks.clerk();
    context.mocks.posthog();
    context.mocks.sentry();
  });

  afterEach(stopApplication);

  it("keeps startup image generation disabled behind its feature switch", async () => {
    const avatar = setupPlatformDocument();
    context.mocks.browser.matchMedia((query) => {
      return query === "(prefers-color-scheme: dark)";
    });
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

  it("renders the uncropped startup illustration and refreshes it after rotation", async () => {
    const avatar = setupPlatformDocument();
    let orientation: "landscape" | "portrait" = "portrait";
    const resolveMedia = (query: string): boolean => {
      return (
        query === "(prefers-color-scheme: dark)" ||
        (query === "(orientation: portrait)" && orientation === "portrait")
      );
    };
    const media = context.mocks.browser.matchMedia(resolveMedia);
    const image = context.mocks.browser.imageDimensions({
      height: 480,
      width: 480,
    });
    const canvas = context.mocks.browser.canvasRendering();
    const measuredProbes: HTMLElement[] = [];
    const originalBoundingClientRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function getStartupImageLayout(this: Element): DOMRect {
        const probe = this.closest(".app-bootstrap-skeleton__content");
        if (this.classList.contains("app-bootstrap-skeleton__avatar")) {
          if (probe instanceof HTMLElement) {
            measuredProbes.push(probe);
          }
          return orientation === "portrait"
            ? new DOMRect(148, 330, 96, 96)
            : new DOMRect(378, 141, 96, 96);
        }
        if (this.classList.contains("app-bootstrap-skeleton__avatar-layers")) {
          return orientation === "portrait"
            ? new DOMRect(136, 318, 120, 120)
            : new DOMRect(366, 129, 120, 120);
        }
        return originalBoundingClientRect.call(this);
      },
    );
    setStartupImageFeatureSwitch(true);

    startPlatformEntrypoint();

    expect(getComputedStyle(avatar).animationPlayState).toBe("paused");
    await waitFor(() => {
      expect(
        document.querySelectorAll('link[rel="apple-touch-startup-image"]'),
      ).toHaveLength(1);
    });

    const portraitLink = document.querySelector<HTMLLinkElement>(
      'link[rel="apple-touch-startup-image"]',
    );
    expect(portraitLink).not.toBeNull();
    expect(portraitLink?.media).toBe("screen and (orientation: portrait)");
    expect(portraitLink?.getAttribute("href")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(getComputedStyle(avatar).animationPlayState).toBe("running");
    expect(avatar.getAttribute("style")).toBeNull();
    expect(canvas.renders).toStrictEqual([
      { background: "#19191b", height: 2556, width: 1179 },
    ]);
    expect(canvas.clipCircles).toStrictEqual([]);
    expect(canvas.imageDraws).toStrictEqual([
      {
        height: 360,
        width: 360,
        x: 408,
        y: 954,
      },
    ]);
    expect(measuredProbes).toHaveLength(1);
    expect(measuredProbes[0]).toHaveAttribute("aria-hidden", "true");
    expect(measuredProbes[0]?.inert).toBeTruthy();
    expect(measuredProbes[0]?.style.pointerEvents).toBe("none");
    expect(measuredProbes[0]?.style.visibility).toBe("hidden");
    expect(measuredProbes[0]?.isConnected).toBeFalsy();

    orientation = "landscape";
    media.setMatches(resolveMedia);

    await waitFor(() => {
      expect(canvas.renders).toHaveLength(2);
    });
    expect(canvas.renders[1]).toStrictEqual({
      background: "#19191b",
      height: 1179,
      width: 2556,
    });
    expect(canvas.clipCircles).toStrictEqual([]);
    expect(canvas.imageDraws[1]).toStrictEqual({
      height: 360,
      width: 360,
      x: 1098,
      y: 387,
    });
    expect(
      document.querySelectorAll('link[rel="apple-touch-startup-image"]'),
    ).toHaveLength(2);

    orientation = "portrait";
    media.setMatches(resolveMedia);

    await waitFor(() => {
      expect(canvas.renders).toHaveLength(3);
    });
    expect(
      document.querySelector<HTMLLinkElement>(
        'link[media="screen and (orientation: portrait)"]',
      ),
    ).toBe(portraitLink);
    expect(
      document.querySelectorAll('link[rel="apple-touch-startup-image"]'),
    ).toHaveLength(2);
    expect(measuredProbes).toHaveLength(3);
    expect(image.revokedUrls).toStrictEqual(["blob:mock-image-1"]);
    await waitForApplicationStart();
  });
});
