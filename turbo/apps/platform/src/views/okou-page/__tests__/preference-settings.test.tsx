import { screen, waitFor, within } from "@testing-library/react";
import {
  morningBriefPreferenceContract,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockScrollIntoView(): ReturnType<typeof vi.fn> {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          descriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    },
    { once: true },
  );
  return scrollIntoView;
}

async function expectUnifiedSection(
  section: "preference" | "model" | "debug",
  heading: "Preference" | "Models" | "Debug",
): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(dialog).getByRole("heading", { name: heading })).toBeVisible();
  expect(pathname()).toBe("/agents");
  const params = new URLSearchParams(search());
  expect(params.get("settings")).toBe(section);
  expect(params.has("tab")).toBeFalsy();
}

describe("unified preference settings", () => {
  it.each([
    "/settings",
    "/preferences",
    "/settings?tab=appearance",
    "/preferences?tab=timezone",
  ])(
    "maps the legacy preference URL %s into unified Settings",
    async (path) => {
      detachedSetupPage({ context, path });

      await expectUnifiedSection("preference", "Preference");
      expect(pathname()).toBe("/agents");
    },
  );

  it.each([
    "/settings?tab=model-configuration",
    "/preferences?tab=personal-providers",
  ])("maps the legacy model URL %s into unified Settings", async (path) => {
    detachedSetupPage({ context, path });

    await expectUnifiedSection("model", "Models");
    expect(pathname()).toBe("/agents");
  });

  it("maps a visible legacy Debug tab into unified Debug Settings", async () => {
    detachedSetupPage({
      context,
      path: "/settings?tab=debug",
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    });

    await expectUnifiedSection("debug", "Debug");
    expect(pathname()).toBe("/agents");
  });

  it("retains the unified Debug visibility fallback for legacy links", async () => {
    detachedSetupPage({ context, path: "/preferences?tab=debug" });

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(
      within(dialog).getByRole("heading", { name: "Preference" }),
    ).toBeVisible();
    expect(within(dialog).queryByText("Debug")).not.toBeInTheDocument();
    expect(pathname()).toBe("/agents");
    expect(new URLSearchParams(search()).get("settings")).toBe("debug");
  });

  it.each([
    {
      morningBrief: false,
      officialWorkflows: false,
      visible: false,
    },
    {
      morningBrief: true,
      officialWorkflows: false,
      visible: true,
    },
    {
      morningBrief: false,
      officialWorkflows: true,
      visible: false,
    },
    {
      morningBrief: true,
      officialWorkflows: true,
      visible: true,
    },
  ])(
    "gates Morning Brief loading with morningBrief=$morningBrief independently from officialWorkflows=$officialWorkflows",
    async ({ morningBrief, officialWorkflows, visible }) => {
      let preferenceReads = 0;
      context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
        preferenceReads += 1;
        return respond(200, {
          enabled: false,
          nextRunAt: null,
          timezone: "Asia/Shanghai",
          unavailableReason: null,
        });
      });

      detachedSetupPage({
        context,
        path: "/agents?settings=preference",
        featureSwitches: {
          [FeatureSwitchKey.MorningBrief]: morningBrief,
          [FeatureSwitchKey.OfficialWorkflows]: officialWorkflows,
        },
      });

      const dialog = await screen.findByRole("dialog", { name: "Settings" });
      await waitFor(() => {
        expect({
          cardVisible:
            within(dialog).queryByTestId("morning-brief-preference") !== null,
          preferenceLoaded: preferenceReads > 0,
        }).toStrictEqual({
          cardVisible: visible,
          preferenceLoaded: visible,
        });
      });
    },
  );

  it("preserves the legacy Morning Brief focus and displays its authoritative next email", async () => {
    const scrollIntoView = mockScrollIntoView();
    const nextRunAt = "2030-01-02T23:30:00.000Z";
    context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
      return respond(200, {
        enabled: true,
        nextRunAt,
        timezone: "Asia/Shanghai",
        unavailableReason: null,
      });
    });

    detachedSetupPage({
      context,
      path: "/settings?tab=timezone&focus=morning-brief",
      featureSwitches: {
        [FeatureSwitchKey.MorningBrief]: true,
        [FeatureSwitchKey.OfficialWorkflows]: false,
      },
    });

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const card = within(dialog).getByTestId("morning-brief-preference");
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Shanghai",
    }).format(new Date(nextRunAt));
    expect(
      within(dialog).getByText(`Next email ${formatted} (Asia/Shanghai)`),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("switch", { name: "Morning Brief" }),
    ).toBeChecked();
    expect(within(dialog).queryByText("Send now")).not.toBeInTheDocument();
    expect(pathname()).toBe("/agents");
    const params = new URLSearchParams(search());
    expect(params.get("settings")).toBe("preference");
    expect(params.get("focus")).toBe("morning-brief");
    expect(params.has("tab")).toBeFalsy();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(card).toHaveFocus();
  });

  it("updates Morning Brief and renders its actionable conflict state", async () => {
    const captured: boolean[] = [];
    let preference: MorningBriefPreferenceResponse = {
      enabled: false,
      nextRunAt: null,
      timezone: "Asia/Shanghai",
      unavailableReason: null,
    };
    let conflicted = false;
    context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
      if (conflicted) {
        return respond(409, {
          error: {
            code: "MORNING_BRIEF_MULTIPLE_INSTALLATIONS",
            message: "conflict",
          },
        });
      }
      return respond(200, preference);
    });
    context.mocks.api(
      morningBriefPreferenceContract.update,
      ({ body, respond }) => {
        captured.push(body.enabled);
        if (!body.enabled) {
          conflicted = true;
          return respond(409, {
            error: {
              code: "MORNING_BRIEF_MULTIPLE_INSTALLATIONS",
              message: "conflict",
            },
          });
        }
        preference = {
          enabled: true,
          nextRunAt: "2030-01-02T23:00:00.000Z",
          timezone: "Asia/Shanghai",
          unavailableReason: null,
        };
        return respond(200, preference);
      },
    );

    detachedSetupPage({
      context,
      path: "/agents?settings=preference",
      featureSwitches: {
        [FeatureSwitchKey.MorningBrief]: true,
        [FeatureSwitchKey.OfficialWorkflows]: false,
      },
    });
    const toggle = await screen.findByRole("switch", {
      name: "Morning Brief",
    });
    click(toggle);
    await waitFor(() => {
      expect(captured).toStrictEqual([true]);
      expect(toggle).toBeChecked();
    });

    click(toggle);
    await waitFor(() => {
      expect(
        screen.getByText(/Multiple Morning Brief installations exist/u),
      ).toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      const retry = queryAllByRoleFast("button").find((button) => {
        return button.textContent === "Retry";
      });
      expect(retry).toBeEnabled();
    });
  });
});
