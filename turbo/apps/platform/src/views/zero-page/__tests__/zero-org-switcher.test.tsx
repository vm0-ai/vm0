import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("zero org switcher", () => {
  it("should show red dot when there are pending invitations", async () => {
    mockAPIs();
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [{ id: "org_1" }],
        pendingInvitations: [
          {
            id: "inv_1",
            publicOrganizationData: {
              id: "org_invited",
              name: "Invited Org",
              imageUrl: "",
            },
            accept: () => {
              return Promise.resolve({});
            },
          },
        ],
      },
    });

    await waitFor(() => {
      const dot = document.querySelector(".bg-destructive");
      expect(dot).toBeInTheDocument();
    });
  });

  it("should not show red dot when there are no pending invitations", async () => {
    mockAPIs();
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [{ id: "org_1" }],
        pendingInvitations: [],
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    expect(document.querySelector(".bg-destructive")).not.toBeInTheDocument();
  });

  it("should show Join button in dropdown for pending invitations", async () => {
    mockAPIs();
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [{ id: "org_1" }],
        pendingInvitations: [
          {
            id: "inv_1",
            publicOrganizationData: {
              id: "org_invited",
              name: "Invited Org",
              imageUrl: "",
            },
            accept: () => {
              return Promise.resolve({});
            },
          },
        ],
      },
    });

    const user = userEvent.setup();

    // Open the dropdown
    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Current Org"));

    await waitFor(() => {
      expect(screen.getByText("Invited Org")).toBeInTheDocument();
      expect(screen.getByText("Join")).toBeInTheDocument();
    });
  });

  it("should call accept without switching org when Join is clicked", async () => {
    const acceptSpy = vi.fn(() => {
      return Promise.resolve({});
    });

    mockAPIs();
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [{ id: "org_1" }],
        pendingInvitations: [
          {
            id: "inv_1",
            publicOrganizationData: {
              id: "org_invited",
              name: "Invited Org",
              imageUrl: "",
            },
            accept: acceptSpy,
          },
        ],
      },
    });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Current Org"));

    await waitFor(() => {
      expect(screen.getByText("Join")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Join"));

    await waitFor(() => {
      expect(acceptSpy).toHaveBeenCalledWith();
    });
  });
});
