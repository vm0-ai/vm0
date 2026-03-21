import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { UserPreferencesResponse } from "@vm0/core";

const context = testContext();

function createMockPreferences(
  overrides?: Partial<UserPreferencesResponse>,
): UserPreferencesResponse {
  return {
    timezone: "UTC",
    notifyEmail: false,
    notifySlack: false,
    pinnedAgentIds: [],
    sendMode: "enter",
    ...overrides,
  };
}

function mockPreferencesAPI(prefs = createMockPreferences()) {
  server.use(
    http.get("*/api/zero/user-preferences", () => {
      return HttpResponse.json(prefs);
    }),
  );
}

async function renderPreferencesPage() {
  await setupPage({ context, path: "/preferences" });
}

describe("zero preferences page - header and tabs", () => {
  it("should render page title and subtitle", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Preferences")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Manage your appearance, notification and agent runtime preferences",
      ),
    ).toBeInTheDocument();
  });

  it("should render all three tabs", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Appearance")).toBeInTheDocument();
    });
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByText("Time Zone")).toBeInTheDocument();
  });

  it("should show appearance tab content by default", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });
    expect(screen.getByText("Your preferred color scheme")).toBeInTheDocument();
    expect(screen.getByText("Send message with")).toBeInTheDocument();
  });
});

describe("zero preferences page - appearance tab", () => {
  it("should render theme options (Light, Dark, System)", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Light")).toBeInTheDocument();
    });
    expect(screen.getByText("Dark")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("should render send mode options (Enter, Cmd+Enter)", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Enter")).toBeInTheDocument();
    });
  });

  it("should show description for current send mode", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(
        screen.getByText("Press Enter to send, Shift+Enter for new line"),
      ).toBeInTheDocument();
    });
  });

  it("should allow clicking a theme option", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Dark"));

    // After clicking Dark, the Dark button should reflect the active state
    // The theme is applied via localStorage + DOM, so we verify it doesn't crash
    expect(screen.getByText("Dark")).toBeInTheDocument();
  });
});

describe("zero preferences page - tab switching", () => {
  it("should switch to notifications tab", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Notifications")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Notifications"));

    await waitFor(() => {
      expect(screen.getByText("Email Notifications")).toBeInTheDocument();
    });
    expect(screen.getByText("Slack Notifications")).toBeInTheDocument();
  });

  it("should switch to time zone tab", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Time Zone")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Your agents will use this time zone during runs"),
    ).toBeInTheDocument();
  });

  it("should switch back to appearance tab from notifications", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Notifications")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Notifications"));

    await waitFor(() => {
      expect(screen.getByText("Email Notifications")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Appearance"));

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });
  });
});

describe("zero preferences page - notifications tab", () => {
  it("should render email and slack notification toggles", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Notifications")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Notifications"));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Toggle email notifications"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByLabelText("Toggle Slack notifications"),
    ).toBeInTheDocument();
  });

  it("should show notification descriptions", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Notifications")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Notifications"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Receive an email when a scheduled agent run completes or fails.",
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Get a Slack DM when a scheduled agent run completes or fails.",
      ),
    ).toBeInTheDocument();
  });

  it("should send update request when toggling email notification", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json(createMockPreferences());
      }),
      http.post("*/api/zero/user-preferences", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(createMockPreferences({ notifyEmail: true }));
      }),
    );

    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Notifications")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Notifications"));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Toggle email notifications"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Toggle email notifications"));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("notifyEmail", true);
  });
});

describe("zero preferences page - timezone tab", () => {
  it("should render timezone description and selector", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Time Zone")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Sets the TZ environment variable for your agent sandbox at runtime.",
        ),
      ).toBeInTheDocument();
    });
  });
});

describe("zero preferences page - send mode interaction", () => {
  it("should send update request when changing send mode", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json(createMockPreferences({ sendMode: "enter" }));
      }),
      http.post("*/api/zero/user-preferences", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          createMockPreferences({ sendMode: "cmd-enter" }),
        );
      }),
    );

    await renderPreferencesPage();

    // The cmd+enter button text uses the special character
    await waitFor(() => {
      expect(screen.getByText("Send message with")).toBeInTheDocument();
    });

    // Click the Cmd+Enter option
    const cmdEnterButtons = screen.getAllByRole("button");
    const cmdEnterButton = cmdEnterButtons.find(
      (btn) =>
        btn.textContent?.includes("Enter") &&
        btn.textContent?.includes("\u2318"),
    );
    expect(cmdEnterButton).toBeTruthy();
    fireEvent.click(cmdEnterButton!);

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("sendMode", "cmd-enter");
  });
});
