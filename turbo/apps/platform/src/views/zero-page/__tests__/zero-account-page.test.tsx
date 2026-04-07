/**
 * Views tests for zero-account-page.tsx (ZeroPreferencesPage)
 * Tests theme preference display and selection, send mode configuration,
 * saving indicator, and tab switching between appearance and timezone.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { UserPreferencesResponse } from "@vm0/core";

const context = testContext();

function mockPreferencesAPI(
  prefs: Omit<UserPreferencesResponse, "captureNetworkBodiesRemaining">,
) {
  const full: UserPreferencesResponse = {
    captureNetworkBodiesRemaining: 0,
    ...prefs,
  };
  server.use(
    http.get("*/api/zero/user-preferences", () => {
      return HttpResponse.json(full);
    }),
  );
}

async function renderPreferencesPage() {
  await setupPage({ context, path: "/settings" });
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
    const user = userEvent.setup();
    mockPreferencesAPI({
      timezone: "Etc/UTC",
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });
    expect(screen.queryByText("Theme")).not.toBeInTheDocument();
  });
});

describe("zero-account-page - theme interaction", () => {
  it("activates light mode when Light button is clicked (PREF-D-005)", async () => {
    const user = userEvent.setup();
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

    await user.click(lightBtn);

    await waitFor(() => {
      expect(lightBtn).toHaveAttribute("aria-pressed", "true");
      expect(findButtonByText("System")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("activates dark mode when Dark button is clicked (PREF-D-006)", async () => {
    const user = userEvent.setup();
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

    await user.click(darkBtn);

    await waitFor(() => {
      expect(darkBtn).toHaveAttribute("aria-pressed", "true");
      expect(findButtonByText("System")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("activates system mode when System button is clicked after switching away (PREF-D-007)", async () => {
    const user = userEvent.setup();
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

    await user.click(lightBtn);
    await waitFor(() => {
      expect(lightBtn).toHaveAttribute("aria-pressed", "true");
    });

    const systemBtn = findButtonByText("System") as HTMLElement;
    await user.click(systemBtn);

    await waitFor(() => {
      expect(systemBtn).toHaveAttribute("aria-pressed", "true");
      expect(lightBtn).toHaveAttribute("aria-pressed", "false");
    });
  });
});

describe("zero-account-page - send mode saving", () => {
  it("disables send mode buttons while saving (PREF-D-003)", async () => {
    const user = userEvent.setup();
    mockPreferencesAPI({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
    });
    const deferred = makeDeferred();
    server.use(
      http.post("*/api/zero/user-preferences", () => {
        return deferred.promise.then(() => {
          return HttpResponse.json({
            timezone: null,
            pinnedAgentIds: [],
            sendMode: "cmd-enter",
          });
        });
      }),
    );
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Send message with")).toBeInTheDocument();
    });

    const cmdEnterBtn = findCmdEnterButton();
    expect(cmdEnterBtn).toBeInTheDocument();
    await user.click(cmdEnterBtn as HTMLElement);

    await waitFor(() => {
      const enterBtn = findButtonByText("Enter");
      expect(enterBtn).toBeInTheDocument();
      expect(enterBtn).toBeDisabled();
    });

    deferred.resolve();
  });
});

describe("zero-account-page - send mode interaction", () => {
  it("selects Enter send mode when Enter button is clicked (PREF-D-008)", async () => {
    const user = userEvent.setup();
    const deferred = makeDeferred();
    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "cmd-enter",
        });
      }),
      http.post("*/api/zero/user-preferences", () => {
        return deferred.promise.then(() => {
          return HttpResponse.json({
            timezone: null,
            pinnedAgentIds: [],
            sendMode: "enter",
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
    await user.click(enterBtn);

    await waitFor(() => {
      expect(enterBtn).toHaveAttribute("aria-pressed", "true");
    });

    deferred.resolve();
  });

  it("selects Cmd+Enter send mode when Cmd+Enter button is clicked (PREF-D-009)", async () => {
    const user = userEvent.setup();
    const deferred = makeDeferred();
    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
        });
      }),
      http.post("*/api/zero/user-preferences", () => {
        return deferred.promise.then(() => {
          return HttpResponse.json({
            timezone: null,
            pinnedAgentIds: [],
            sendMode: "cmd-enter",
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
    await user.click(cmdEnterBtn);

    await waitFor(() => {
      expect(cmdEnterBtn).toHaveAttribute("aria-pressed", "true");
    });

    deferred.resolve();
  });
});
