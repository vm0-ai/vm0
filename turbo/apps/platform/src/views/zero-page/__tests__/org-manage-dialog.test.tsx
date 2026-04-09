import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockAPIs(overrides?: { role?: string }) {
  server.use(
    http.get("*/api/zero/org", () => {
      return HttpResponse.json({
        id: "org_1",
        slug: "test-org",
        name: "Test Org",
        role: overrides?.role ?? "admin",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/org/logo", () => {
      return HttpResponse.json({ logoUrl: null });
    }),
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
  );
}

async function openDialog() {
  detachedSetupPage({ context, path: "/?settings=general" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("org manage dialog - display", () => {
  it("shows tab navigation items in the sidebar", async () => {
    mockAPIs();
    await openDialog();

    // Always-visible tabs
    expect(
      screen.getAllByRole("button").find((el) => {
        return /General/i.test(el.textContent ?? "");
      })!,
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button").find((el) => {
        return /Members/i.test(el.textContent ?? "");
      })!,
    ).toBeInTheDocument();

    // Admin-visible tabs
    expect(screen.getByText(/Model Providers/i)).toBeInTheDocument();
  });

  it("shows the active tab heading on initial load", async () => {
    mockAPIs();
    await openDialog();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "General" }),
      ).toBeInTheDocument();
    });
  });
});

describe("org manage dialog - conditional", () => {
  it("renders both desktop sidebar nav buttons and mobile select dropdown", async () => {
    mockAPIs();
    await openDialog();

    // Desktop sidebar has tab buttons
    expect(
      screen.getAllByRole("button").find((el) => {
        return /General/i.test(el.textContent ?? "");
      })!,
    ).toBeInTheDocument();

    // Mobile nav has a combobox/select
    const combobox = screen.getByRole("combobox");
    expect(combobox).toBeInTheDocument();
  });

  it("shows Configuration and Billing groups for admin users", async () => {
    mockAPIs({ role: "admin" });
    await openDialog();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Configuration")).toBeInTheDocument();
    expect(within(dialog).getByText("Billing & pricing")).toBeInTheDocument();
  });

  it("hides Configuration and Billing groups for non-admin users", async () => {
    mockAPIs({ role: "member" });
    await openDialog();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Configuration")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("Billing & pricing"),
    ).not.toBeInTheDocument();
  });
});

describe("org manage dialog - interaction", () => {
  it("switches tab content when a sidebar button is clicked", async () => {
    const user = userEvent.setup();
    mockAPIs();
    server.use(
      http.get("*/api/zero/org/members", () => {
        return HttpResponse.json({
          slug: "test-org",
          role: "admin",
          members: [],
          pendingInvitations: [],
          createdAt: "2026-01-01T00:00:00Z",
        });
      }),
    );

    await openDialog();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "General" }),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getAllByRole("button").find((el) => {
        return /Members/i.test(el.textContent ?? "");
      })!,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Members" }),
      ).toBeInTheDocument();
    });
  });

  it("switches tab content when the mobile select dropdown is changed", async () => {
    const user = userEvent.setup();
    mockAPIs();
    server.use(
      http.get("*/api/zero/org/members", () => {
        return HttpResponse.json({
          slug: "test-org",
          role: "admin",
          members: [],
          pendingInvitations: [],
          createdAt: "2026-01-01T00:00:00Z",
        });
      }),
    );

    await openDialog();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "General" }),
      ).toBeInTheDocument();
    });

    const combobox = screen.getByRole("combobox");
    await user.click(combobox);

    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /Members/i }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("option", { name: /Members/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Members" }),
      ).toBeInTheDocument();
    });
  });
});

describe("org manage dialog - state", () => {
  it("opens and closes the dialog correctly", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await openDialog();

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByLabelText(/close/i));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
