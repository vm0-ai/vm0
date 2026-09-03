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
const BOOTSTRAP_AVATAR_SELECTOR = ".app-bootstrap-skeleton__avatar";
const BOOTSTRAP_AVATAR_LAYERS_SELECTOR =
  ".app-bootstrap-skeleton__avatar-layers";
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

describe.each(["app.vm0.ai", "app.okou.ai"])(
  "platform entrypoint on %s",
  (hostname) => {
    beforeEach(() => {
      googleAdsRequestedAfterApplicationStart = false;
      context.mocks.browser.url(`https://${hostname}/`);
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
    });

    afterEach(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    it("does not inject the Instatus widget", () => {
      expect(instatusScripts()).toStrictEqual([]);
    });

    it("starts the application before requesting Google Ads", () => {
      expect(googleAdsRequestedAfterApplicationStart).toBeTruthy();
    });
  },
);

describe("iOS PWA startup image entrypoint", () => {
  let portraitOrientation = true;
  let setPortraitOrientation: (portrait: boolean) => void;

  const matchesMediaQuery = (query: string): boolean => {
    return (
      query === "(prefers-color-scheme: dark)" ||
      (query === "(orientation: portrait)" && portraitOrientation)
    );
  };

  const mockBootstrapLayout = (): void => {
    context.mocks.browser.boundingClientRect((element) => {
      const content = element.closest(BOOTSTRAP_CONTENT_SELECTOR);
      if (
        !(content instanceof HTMLElement) ||
        content.style.visibility !== "hidden" ||
        content.style.pointerEvents !== "none" ||
        !content.inert
      ) {
        return undefined;
      }

      if (element.matches(BOOTSTRAP_AVATAR_SELECTOR)) {
        return portraitOrientation
          ? { height: 64, width: 64, x: 169, y: 392 }
          : { height: 64, width: 64, x: 405, y: 163 };
      }
      if (element.matches(BOOTSTRAP_AVATAR_LAYERS_SELECTOR)) {
        return portraitOrientation
          ? { height: 64, width: 64, x: 169, y: 392 }
          : { height: 64, width: 64, x: 405, y: 163 };
      }
      return undefined;
    });
  };

  beforeEach(() => {
    portraitOrientation = true;
    context.mocks.browser.url("https://app.vm0.ai/");
    context.mocks.browser.userAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    );
    context.mocks.browser.platform("iPhone");
    context.mocks.browser.maxTouchPoints(5);
    context.mocks.browser.screen({ height: 874, pixelRatio: 3, width: 402 });
    const mediaQueries = context.mocks.browser.matchMedia(matchesMediaQuery);
    setPortraitOrientation = (portrait) => {
      portraitOrientation = portrait;
      mediaQueries.setMatches(matchesMediaQuery);
    };
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
  });

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
  });

  it("measures an invisible skeleton probe for each generated orientation", async () => {
    const avatar = setupPlatformDocument();
    const content = document.querySelector(BOOTSTRAP_CONTENT_SELECTOR);
    if (!(content instanceof HTMLElement)) {
      throw new Error("Missing bootstrap content in the Platform index");
    }
    mockBootstrapLayout();
    const image = context.mocks.browser.imageDimensions({
      height: 480,
      width: 480,
    });
    const canvas = context.mocks.browser.canvasRendering();
    setStartupImageFeatureSwitch(true);

    startPlatformEntrypoint();

    expect(getComputedStyle(avatar).animationPlayState).toBe("paused");
    expect(content.style.top).toBe("");
    await waitFor(() => {
      expect(
        document.querySelectorAll('link[rel="apple-touch-startup-image"]'),
      ).toHaveLength(1);
    });

    expect(getComputedStyle(avatar).animationPlayState).toBe("running");
    expect(canvas.renders).toStrictEqual([
      {
        avatar: {
          height: 192,
          width: 192,
          x: 507,
          y: 1176,
        },
        background: "#19191b",
        height: 2622,
        width: 1206,
      },
    ]);
    const portraitLink = document.querySelector<HTMLLinkElement>(
      'link[rel="apple-touch-startup-image"]',
    );
    expect(portraitLink).toMatchObject({
      media: "screen and (orientation: portrait)",
    });
    expect(portraitLink?.getAttribute("href")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(document.querySelectorAll(BOOTSTRAP_CONTENT_SELECTOR)).toHaveLength(
      1,
    );
    expect(image.revokedUrls).toStrictEqual(["blob:mock-image-1"]);

    setPortraitOrientation(false);
    await waitFor(() => {
      expect(canvas.renders).toHaveLength(2);
    });
    expect(canvas.renders[1]).toStrictEqual({
      avatar: {
        height: 192,
        width: 192,
        x: 1215,
        y: 489,
      },
      background: "#19191b",
      height: 1206,
      width: 2622,
    });
    expect(
      [
        ...document.querySelectorAll<HTMLLinkElement>(
          'link[rel="apple-touch-startup-image"]',
        ),
      ].map((link) => {
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

    setPortraitOrientation(true);
    await waitFor(() => {
      expect(canvas.renders).toHaveLength(3);
    });
    expect(
      document.querySelectorAll(
        'link[rel="apple-touch-startup-image"][media="screen and (orientation: portrait)"]',
      ),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('link[rel="apple-touch-startup-image"]'),
    ).toHaveLength(2);
    expect(
      document.querySelector<HTMLLinkElement>(
        'link[rel="apple-touch-startup-image"][media="screen and (orientation: portrait)"]',
      ),
    ).toBe(portraitLink);
    expect(portraitLink?.getAttribute("href")).toBe(
      "data:image/png;base64,AAAB",
    );
    expect(content.style.top).toBe("");
    expect(document.querySelectorAll(BOOTSTRAP_CONTENT_SELECTOR)).toHaveLength(
      1,
    );
  });
});
