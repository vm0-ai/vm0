import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockOrg, resetMockOrg } from "../../../mocks/handlers/api-org.ts";
import {
  setMockOrgMembers,
  resetMockOrgMembers,
} from "../../../mocks/handlers/api-org-members.ts";
import { setOrgManageDialogOpen$ } from "../../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveOrgManageTab$ } from "../../../signals/zero-page/settings/org-manage-tabs-state.ts";

const context = testContext();

beforeEach(() => {
  resetMockOrg();
  resetMockOrgMembers();
});

async function openDialog() {
  detachedSetupPage({ context, path: "/" });
  context.store.set(setActiveOrgManageTab$, "general");
  await context.store.set(setOrgManageDialogOpen$, true, context.signal);
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("org manage dialog - display", () => {
  it("shows tab navigation items in the sidebar", async () => {
    setMockOrg({ slug: "test-org", name: "Test Org", role: "admin" });
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
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getByText("Credit balance")).toBeInTheDocument();
  });

  it("shows the active tab heading on initial load", async () => {
    setMockOrg({ slug: "test-org", name: "Test Org", role: "admin" });
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
    setMockOrg({ slug: "test-org", name: "Test Org", role: "admin" });
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
    setMockOrg({ role: "admin" });
    await openDialog();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Configuration")).toBeInTheDocument();
    expect(within(dialog).getByText("Billing & pricing")).toBeInTheDocument();
  });

  it("hides Configuration and Billing groups for non-admin users", async () => {
    setMockOrg({ role: "member" });
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
    setMockOrg({ slug: "test-org", name: "Test Org", role: "admin" });
    setMockOrgMembers({
      slug: "test-org",
      role: "admin",
      members: [],
      pendingInvitations: [],
      createdAt: "2026-01-01T00:00:00Z",
    });

    await openDialog();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "General" }),
      ).toBeInTheDocument();
    });

    click(
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
    setMockOrg({ slug: "test-org", name: "Test Org", role: "admin" });
    setMockOrgMembers({
      slug: "test-org",
      role: "admin",
      members: [],
      pendingInvitations: [],
      createdAt: "2026-01-01T00:00:00Z",
    });

    await openDialog();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "General" }),
      ).toBeInTheDocument();
    });

    const combobox = screen.getByRole("combobox");
    click(combobox);

    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /Members/i }),
      ).toBeInTheDocument();
    });
    click(screen.getByRole("option", { name: /Members/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Members" }),
      ).toBeInTheDocument();
    });
  });
});

describe("org manage dialog - state", () => {
  it("opens and closes the dialog correctly", async () => {
    setMockOrg({ slug: "test-org", name: "Test Org", role: "admin" });
    await openDialog();

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    click(screen.getByLabelText(/close/i));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
