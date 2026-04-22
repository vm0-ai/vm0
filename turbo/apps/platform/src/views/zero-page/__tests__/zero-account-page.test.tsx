/**
 * Views tests for zero-account-page.tsx (ZeroPreferencesPage)
 * Tests theme preference display and selection, send mode configuration,
 * saving indicator, and tab switching between appearance and timezone.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/core";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();

function mockPreferencesAPI(
  prefs: Omit<UserPreferencesResponse, "captureNetworkBodiesRemaining">,
) {
  setMockUserPreferences({
    captureNetworkBodiesRemaining: 0,
    ...prefs,
  });
}

function renderPreferencesPage() {
  detachedSetupPage({ context, path: "/settings" });
}

function makeDeferred() {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function findButtonByText(text: string) {
  return screen.getAllByRole("button").find((btn) => {
    return btn.textContent?.trim() === text;
  });
}

function findCmdEnterButton() {
  return screen.getAllByRole("button").find((btn) => {
    const text = btn.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return text.includes("Enter") && text !== "Enter";
  });
}

describe("zero-account-page - theme display", () => {
  it("shows system theme as active by default (PREF-D-001)", async () => {
    mockPreferencesAPI({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await renderPreferencesPage();

    await waitFor(() => {
      const systemBtn = findButtonByText("System");
      expect(systemBtn).toBeInTheDocument();
      expect(systemBtn).toHaveAttribute("aria-pressed", "true");
      const lightBtn = findButtonByText("Light");
      expect(lightBtn).toBeInTheDocument();
      expect(lightBtn).toHaveAttribute("aria-pressed", "false");
    });
  });
});

describe("zero-account-page - send mode display", () => {
  it("shows Enter description when send mode is enter (PREF-D-002)", async () => {
    mockPreferencesAPI({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await renderPreferencesPage();

    await waitFor(() => {
      const enterBtn = findButtonByText("Enter");
      expect(enterBtn).toHaveAttribute("aria-pressed", "true");
    });
  });
});

describe("zero-account-page - tab switching", () => {
  it("switches to timezone tab when clicking Time Zone (PREF-D-004)", async () => {
    mockPreferencesAPI({
      timezone: "Etc/UTC",
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });

    click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });
    expect(screen.queryByText("Theme")).not.toBeInTheDocument();
  });
});

describe("zero-account-page - theme interaction", () => {
  it("activates light mode when Light button is clicked (PREF-D-005)", async () => {
    mockPreferencesAPI({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await renderPreferencesPage();

    const lightBtn = await waitFor(() => {
      const btn = findButtonByText("Light");
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });

    click(lightBtn);

    await waitFor(() => {
      expect(lightBtn).toHaveAttribute("aria-pressed", "true");
      expect(findButtonByText("System")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("activates dark mode when Dark button is clicked (PREF-D-006)", async () => {
    mockPreferencesAPI({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await renderPreferencesPage();

    const darkBtn = await waitFor(() => {
      const btn = findButtonByText("Dark");
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });

    click(darkBtn);

    await waitFor(() => {
      expect(darkBtn).toHaveAttribute("aria-pressed", "true");
      expect(findButtonByText("System")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("activates system mode when System button is clicked after switching away (PREF-D-007)", async () => {
    mockPreferencesAPI({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await renderPreferencesPage();

    const lightBtn = await waitFor(() => {
      const btn = findButtonByText("Light");
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });

    click(lightBtn);
    await waitFor(() => {
      expect(lightBtn).toHaveAttribute("aria-pressed", "true");
    });

    const systemBtn = findButtonByText("System") as HTMLElement;
    click(systemBtn);

    await waitFor(() => {
      expect(systemBtn).toHaveAttribute("aria-pressed", "true");
      expect(lightBtn).toHaveAttribute("aria-pressed", "false");
    });
  });
});

describe("zero-account-page - send mode interaction", () => {
  it("selects Enter send mode when Enter button is clicked (PREF-D-008)", async () => {
    const deferred = makeDeferred();
    setMockUserPreferences({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 0,
    });
    server.use(
      mockApi(zeroUserPreferencesContract.update, ({ respond }) => {
        return deferred.promise.then(() => {
          return respond(200, {
            timezone: null,
            pinnedAgentIds: [],
            sendMode: "enter",
            captureNetworkBodiesRemaining: 0,
          });
        });
      }),
    );
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Send message with")).toBeInTheDocument();
    });

    const enterBtn = findButtonByText("Enter") as HTMLElement;
    expect(enterBtn).toBeInTheDocument();
    click(enterBtn);

    await waitFor(() => {
      expect(enterBtn).toHaveAttribute("aria-pressed", "true");
    });

    deferred.resolve();
  });

  it("selects Cmd+Enter send mode when Cmd+Enter button is clicked (PREF-D-009)", async () => {
    const deferred = makeDeferred();
    setMockUserPreferences({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
      captureNetworkBodiesRemaining: 0,
    });
    server.use(
      mockApi(zeroUserPreferencesContract.update, ({ respond }) => {
        return deferred.promise.then(() => {
          return respond(200, {
            timezone: null,
            pinnedAgentIds: [],
            sendMode: "cmd-enter",
            captureNetworkBodiesRemaining: 0,
          });
        });
      }),
    );
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Send message with")).toBeInTheDocument();
    });

    const cmdEnterBtn = findCmdEnterButton() as HTMLElement;
    expect(cmdEnterBtn).toBeInTheDocument();
    click(cmdEnterBtn);

    await waitFor(() => {
      expect(cmdEnterBtn).toHaveAttribute("aria-pressed", "true");
    });

    deferred.resolve();
  });
});
