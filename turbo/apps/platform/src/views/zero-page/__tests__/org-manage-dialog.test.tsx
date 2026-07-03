import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function openDialog(role: "admin" | "member" = "admin"): Promise<void> {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role,
  });
  context.mocks.data.orgMembers({
    slug: "test-org",
    role,
    members: [],
    pendingInvitations: [],
    membershipRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
  detachedSetupPage({ context, path: "/?settings=general" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("organization management dialog", () => {
  it("lets admins navigate settings tabs without closing the dialog", async () => {
    await openDialog("admin");

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Configuration")).toBeInTheDocument();
    expect(within(dialog).getByText("Billing & pricing")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();

    const membersTab = queryAllByRoleFast("button", dialog).find((element) => {
      return /Members/u.test(element.textContent ?? "");
    });
    if (!membersTab) {
      throw new Error("Members tab not found");
    }
    click(membersTab);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Members" }),
      ).toBeInTheDocument();
    });
  });

  it("routes members away from admin-only workspace settings", async () => {
    await openDialog("member");

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Configuration")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Workspace")).not.toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
  });
});
