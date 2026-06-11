import { screen, waitFor } from "@testing-library/react";
import {
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function createMockPreferences(
  overrides?: Partial<UserPreferencesResponse>,
): UserPreferencesResponse {
  return {
    timezone: "UTC",
    pinnedAgentIds: [],
    sendMode: "enter",
    captureNetworkBodiesRemaining: 0,
    ...overrides,
  };
}

function renderPreferencesPage(): void {
  detachedSetupPage({ context, path: "/settings" });
}

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

describe("preferences page", () => {
  it("switches between preference tabs", async () => {
    context.mocks.data.userPreferences(createMockPreferences());

    renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });

    const darkButton = getButtonByText("Dark");
    click(darkButton);

    await waitFor(() => {
      expect(darkButton).toHaveAttribute("aria-pressed", "true");
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });

    click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });

    click(screen.getByText("Appearance"));

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });
  });

  it("saves send mode and time zone preference changes", async () => {
    const capturedBodies: Record<string, unknown>[] = [];

    context.mocks.data.userPreferences(
      createMockPreferences({ timezone: "UTC" }),
    );
    context.mocks.api(
      zeroUserPreferencesContract.update,
      ({ body, respond }) => {
        capturedBodies.push(body as Record<string, unknown>);
        return respond(200, {
          ...createMockPreferences(),
          ...(body as Partial<UserPreferencesResponse>),
        });
      },
    );

    renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Send message with")).toBeInTheDocument();
    });

    const cmdEnterButton = queryAllByRoleFast("button").find((btn) => {
      return (
        btn.textContent?.includes("Enter") &&
        btn.textContent?.includes("\u2318")
      );
    });
    expect(cmdEnterButton).toBeInTheDocument();
    click(cmdEnterButton as HTMLElement);

    click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });

    click(screen.getByRole("combobox"));

    await waitFor(() => {
      expect(screen.getByText(/Eastern Time \(ET\)/)).toBeInTheDocument();
    });
    click(screen.getByText(/Eastern Time \(ET\)/));

    await waitFor(() => {
      expect(capturedBodies).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ sendMode: "cmd-enter" }),
          expect.objectContaining({ timezone: "America/New_York" }),
        ]),
      );
    });
  });

  it("changes debug network body capture on the preferences page", async () => {
    context.mocks.data.userPreferences(
      createMockPreferences({ captureNetworkBodiesRemaining: 0 }),
    );

    detachedSetupPage({
      context,
      path: "/settings?tab=debug",
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(
        screen.getByText("Enabled for the next 3 runs"),
      ).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });
  });
});
