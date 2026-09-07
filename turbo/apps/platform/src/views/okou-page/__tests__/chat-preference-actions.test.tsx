import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userModelPreferenceContract,
  type UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const STANDARD = "GPT 5.6 Sol";
const INHERIT = "Inherit from org default";

function initialPreference(): UserModelPreferenceResponse {
  return {
    selectedModel: "gpt-5.6-sol",
    serviceTier: null,
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
}

function getButton(dialog: HTMLElement, name: string): HTMLElement {
  const button = queryAllByRoleFast("button", dialog).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Settings button not found: ${name}`);
  }
  return button;
}

async function openChatSettings(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: "/?settings=chat",
    host: "app.vm0.ai",
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.CodexFastMode]: true,
    },
  });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() => {
    expect(
      within(dialog).getByRole("combobox", { name: STANDARD }),
    ).toBeEnabled();
  });
  return dialog;
}

async function chooseModel(dialog: HTMLElement, current: string, next: string) {
  click(within(dialog).getByRole("combobox", { name: current }));
  click(await screen.findByRole("option", { name: next }));
}

async function remountChatSection(dialog: HTMLElement) {
  click(getButton(dialog, "Preference"));
  await within(dialog).findByRole("heading", { name: "Preference" });
  click(getButton(dialog, "Chat"));
  await within(dialog).findByRole("heading", { name: "Chat" });
}

function expectLockedSelection(dialog: HTMLElement, name: string) {
  expect(within(dialog).getByLabelText(name)).toBeVisible();
  expect(within(dialog).queryByRole("combobox", { name })).toBeNull();
}

test.each(["save", "refresh", "failure"] as const)(
  "The default model stays locked across section changes until %s settles",
  async (boundary) => {
    let preference = initialPreference();
    let saved = false;
    let failSave = boundary === "failure";
    const started = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      userModelPreferenceContract.get,
      async ({ respond, withSignal }) => {
        if (saved && boundary === "refresh" && !started.settled()) {
          started.resolve();
          await withSignal(release.promise);
        }
        return respond(200, preference);
      },
    );
    context.mocks.api(
      userModelPreferenceContract.update,
      async ({ body, respond, withSignal }) => {
        if (boundary !== "refresh" && !started.settled()) {
          started.resolve();
          await withSignal(release.promise);
        }
        if (failSave) {
          return respond(500, {
            error: {
              message: "Model preference save failed",
              code: "INTERNAL_SERVER_ERROR",
            },
          });
        }
        preference = {
          ...preference,
          selectedModel: body.selectedModel,
          serviceTier: body.serviceTier,
        };
        saved = true;
        return respond(200, preference);
      },
    );
    const dialog = await openChatSettings();
    await chooseModel(dialog, STANDARD, INHERIT);
    await started.promise;
    await remountChatSection(dialog);
    await within(dialog).findByLabelText(INHERIT);
    expectLockedSelection(dialog, INHERIT);

    release.resolve();
    const expected = boundary === "failure" ? STANDARD : INHERIT;
    await waitFor(() => {
      expect(
        within(dialog).getByRole("combobox", { name: expected }),
      ).toBeEnabled();
    });
    failSave = false;
    const next = expected === STANDARD ? INHERIT : STANDARD;
    await chooseModel(dialog, expected, next);
    await waitFor(() => {
      expect(
        within(dialog).getByRole("combobox", { name: next }),
      ).toBeEnabled();
    });
  },
);

test("A model save survives closing and reopening settings", async () => {
  context.mocks.data.userModelPreference(initialPreference());
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    userModelPreferenceContract.update,
    async ({ body, respond, withSignal }) => {
      started.resolve();
      await withSignal(release.promise);
      const preference = {
        ...initialPreference(),
        selectedModel: body.selectedModel,
        serviceTier: body.serviceTier,
      };
      context.mocks.data.userModelPreference(preference);
      return respond(200, preference);
    },
  );

  const dialog = await openChatSettings();
  await chooseModel(dialog, STANDARD, INHERIT);
  await started.promise;
  await waitFor(() => {
    expect(
      within(dialog).getByRole("switch", { name: "Cloud browser" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(getButton(dialog, "⌘ Enter")).toBeEnabled();
  });
  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  const reopened = await screen.findByRole("dialog", { name: "Settings" });
  click(getButton(reopened, "Chat"));
  await within(reopened).findByRole("heading", { name: "Chat" });
  expectLockedSelection(reopened, INHERIT);

  release.resolve();
  await waitFor(() => {
    expect(
      within(reopened).getByRole("combobox", { name: INHERIT }),
    ).toBeEnabled();
  });
});

function initialUserPreferences(): UserPreferencesResponse {
  return {
    timezone: "Etc/UTC",
    locale: "en-US",
    translationLanguage: null,
    supportedLocales: ["en-US"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
    voiceInputModel: null,
  };
}

test.each([
  { setting: "send mode", boundary: "save", chatEnabled: true },
  { setting: "send mode", boundary: "refresh", chatEnabled: true },
  { setting: "send mode", boundary: "failure", chatEnabled: true },
  { setting: "cloud browser", boundary: "save", chatEnabled: true },
  { setting: "cloud browser", boundary: "refresh", chatEnabled: true },
  { setting: "cloud browser", boundary: "failure", chatEnabled: true },
  { setting: "send mode", boundary: "save", chatEnabled: false },
] as const)(
  "$setting stays selected and locked through $boundary (chat enabled: $chatEnabled)",
  async ({ setting, boundary, chatEnabled }) => {
    let preferences = initialUserPreferences();
    let saved = false;
    const started = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      userPreferencesContract.get,
      async ({ respond, withSignal }) => {
        if (saved && boundary === "refresh") {
          started.resolve();
          await withSignal(release.promise);
        }
        return respond(200, preferences);
      },
    );
    context.mocks.api(
      userPreferencesContract.update,
      async ({ body, respond, withSignal }) => {
        if (boundary !== "refresh") {
          started.resolve();
          await withSignal(release.promise);
        }
        if (boundary === "failure") {
          return respond(500, {
            error: {
              message: "Preference save failed",
              code: "INTERNAL_SERVER_ERROR",
            },
          });
        }
        preferences = { ...preferences, ...body };
        saved = true;
        return respond(200, preferences);
      },
    );
    await setupPage({
      context,
      path: "/?settings=chat",
      host: "app.vm0.ai",
      featureSwitches: { [FeatureSwitchKey.ChatPreference]: chatEnabled },
    });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const control = () => {
      return setting === "send mode"
        ? getButton(dialog, "⌘ Enter")
        : within(dialog).getByRole("switch", { name: "Cloud browser" });
    };
    const selectionAttribute =
      setting === "send mode" ? "aria-pressed" : "aria-checked";
    const submittedSelection = setting === "send mode" ? "true" : "false";
    const isDisabled = () => {
      return setting === "send mode"
        ? [control(), getButton(dialog, "Enter")].every((element) => {
            return element.hasAttribute("disabled");
          })
        : control().getAttribute("aria-disabled") === "true";
    };
    await waitFor(() => {
      expect(isDisabled()).toBeFalsy();
    });
    click(control());
    await started.promise;
    const expectSubmittedValue = () => {
      expect(isDisabled()).toBeTruthy();
      expect(control()).toHaveAttribute(selectionAttribute, submittedSelection);
    };
    await waitFor(expectSubmittedValue);

    if (chatEnabled) {
      await remountChatSection(dialog);
    } else {
      click(getButton(dialog, "General"));
      await within(dialog).findByRole("heading", { name: "General" });
      click(getButton(dialog, "Preference"));
      await within(dialog).findByRole("heading", { name: "Preference" });
    }
    expectSubmittedValue();
    release.resolve();
    await waitFor(() => {
      expect(isDisabled()).toBeFalsy();
    });
    const selected =
      setting === "send mode" ? boundary !== "failure" : boundary === "failure";
    expect(control()).toHaveAttribute(selectionAttribute, String(selected));
  },
);
