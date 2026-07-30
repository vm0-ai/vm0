import { screen, waitFor } from "@testing-library/react";
import {
  zeroBrowserContract,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { afterEach, describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { i18n } from "../../../i18n/index.ts";

const context = testContext();

afterEach(async () => {
  await i18n.changeLanguage("en-US");
  document.documentElement.lang = "en-US";
});

const threadId = "c0000000-0000-4000-a000-000000000091";
const liveUrl = "https://live.browser-use.com/?wss=test-browser-page-token";

function browserSession(
  overrides: Partial<ZeroBrowserSession> = {},
): ZeroBrowserSession {
  return {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://app.vm0.ai/browsers/${threadId}`,
    liveUrl,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    maxCredits: 1,
    grossCredits: 0,
    creditsCharged: 0,
    idleExpiresAt: "2026-07-24T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("browser session page", () => {
  it.each([
    {
      locale: "en-US",
      title: "Browser not live",
      start: "Start browser",
    },
    {
      locale: "pt-BR",
      title: "Navegador não está ao vivo",
      start: "Iniciar navegador",
    },
  ] as const)(
    "localizes a suspended browser in $locale",
    async ({ locale, title, start }) => {
      context.mocks.data.userPreferences({ locale });
      context.mocks.api(zeroBrowserContract.get, ({ respond }) => {
        return respond(200, {
          browser: browserSession({
            status: "suspended",
            liveUrl: null,
            suspendedAt: "2026-07-24T10:12:00.000Z",
            suspensionReason: "idle",
            idleExpiresAt: null,
          }),
        });
      });

      detachedSetupPage({
        context,
        path: `/browsers/${threadId}`,
        featureSwitches: { [FeatureSwitchKey.LanguagePreference]: true },
      });

      await expect(screen.findByText(title)).resolves.toBeInTheDocument();
      const startButton = queryAllByRoleFast("button").find((candidate) => {
        return candidate.textContent === start;
      });
      expect(startButton).toBeDefined();
    },
  );

  it("loads the authenticated live viewer and keeps the browser leased while it is open", async () => {
    let leaseRequests = 0;
    context.mocks.api(zeroBrowserContract.get, ({ params, respond }) => {
      expect(params.threadId).toBe(threadId);
      return respond(200, { browser: browserSession() });
    });
    context.mocks.api(
      zeroBrowserContract.leaseByThread,
      ({ params, respond }) => {
        expect(params.threadId).toBe(threadId);
        leaseRequests += 1;
        return respond(200, { browser: browserSession() });
      },
    );

    detachedSetupPage({
      context,
      path: `/browsers/${threadId}`,
    });

    const frame = await screen.findByTitle("Live browser: booking");
    expect(frame).toHaveAttribute("src", liveUrl);
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await waitFor(() => {
      expect(leaseRequests).toBeGreaterThan(0);
    });
  });

  it("offers a start action that restarts a reclaimed browser", async () => {
    let getRequests = 0;
    context.mocks.api(zeroBrowserContract.get, ({ respond }) => {
      getRequests += 1;
      return respond(200, {
        browser: browserSession({
          status: "suspended",
          liveUrl: null,
          suspendedAt: "2026-07-24T10:12:00.000Z",
          suspensionReason: "idle",
          idleExpiresAt: null,
        }),
      });
    });
    let startRequests = 0;
    context.mocks.api(
      zeroBrowserContract.start,
      ({ body, params, respond }) => {
        expect(params.threadId).toBe(threadId);
        expect(body.eventId).toBeTypeOf("string");
        startRequests += 1;
        return respond(200, {
          browser: browserSession(),
          lifecycleEventId: body.eventId,
        });
      },
    );
    context.mocks.api(zeroBrowserContract.leaseByThread, ({ respond }) => {
      return respond(200, { browser: browserSession() });
    });

    detachedSetupPage({
      context,
      path: `/browsers/${threadId}`,
    });

    const start = await waitFor(() => {
      const button = queryAllByRoleFast("button").find((candidate) => {
        return candidate.textContent === "Start browser";
      });
      expect(button).toBeDefined();
      return button;
    });
    expect(getRequests).toBeGreaterThan(0);
    start?.click();

    const frame = await screen.findByTitle("Live browser: booking");
    expect(frame).toHaveAttribute("src", liveUrl);
    expect(startRequests).toBe(1);
  });
});
