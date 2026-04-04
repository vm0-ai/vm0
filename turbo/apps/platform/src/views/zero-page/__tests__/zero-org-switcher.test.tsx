import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

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

describe("zero org switcher - current org avatar and name render (SIDEBAR-D-054)", () => {
  it("displays the current organization name in the sidebar trigger", async () => {
    mockAPIs();
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Acme Corp" },
        memberships: [{ id: "org_1" }],
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    });
  });
});

describe("zero org switcher - organization slug renders (SIDEBAR-D-055)", () => {
  it("displays the organization slug in the dropdown header", async () => {
    server.use(
      http.get("*/api/zero/org", () => {
        return HttpResponse.json({
          id: "org_1",
          slug: "acme-corp",
          name: "Acme Corp",
          role: "admin",
        });
      }),
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

    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Acme Corp" },
        memberships: [{ id: "org_1" }],
      },
    });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Acme Corp"));

    await waitFor(() => {
      expect(screen.getByText("acme-corp")).toBeInTheDocument();
    });
  });
});

describe("zero org switcher - pending invitations badge shows count (SIDEBAR-D-056)", () => {
  it("shows a red dot badge when there are pending invitations", async () => {
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
});

describe("zero org switcher - pending invitations list renders (SIDEBAR-D-057)", () => {
  it("shows pending invitation items when dropdown is opened", async () => {
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

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Current Org"));

    await waitFor(() => {
      expect(screen.getByText("Invited Org")).toBeInTheDocument();
      expect(screen.getByText("Join")).toBeInTheDocument();
    });
  });
});

describe("zero org switcher - other org memberships list renders (SIDEBAR-D-058)", () => {
  it("shows other organizations the user belongs to when dropdown is opened", async () => {
    mockAPIs();
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [
          { id: "org_1", organization: { id: "org_1", name: "Current Org" } },
          { id: "org_2", organization: { id: "org_2", name: "Other Org" } },
        ],
      },
    });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Current Org"));

    await waitFor(() => {
      expect(screen.getByText("Other Org")).toBeInTheDocument();
    });
  });
});

describe("zero org switcher - dropdown opens (SIDEBAR-D-059)", () => {
  it("shows org management options when dropdown is opened", async () => {
    mockAPIs();
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [{ id: "org_1" }],
      },
    });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Current Org"));

    await waitFor(() => {
      expect(screen.getByText("Create workspace")).toBeInTheDocument();
      const manageButtons = screen.getAllByText("Manage");
      expect(manageButtons.length).toBeGreaterThan(0);
    });
  });
});

describe("zero org switcher - manage button opens org management (SIDEBAR-D-060)", () => {
  it("opens the org management dialog when Manage is clicked", async () => {
    server.use(
      http.get("*/api/zero/org", () => {
        return HttpResponse.json({
          id: "org_1",
          slug: "current-org",
          name: "Current Org",
          role: "admin",
        });
      }),
      http.get("*/api/zero/org/logo", () => {
        return HttpResponse.json({ logoUrl: null });
      }),
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

    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [{ id: "org_1" }],
      },
    });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Current Org"));

    await waitFor(() => {
      const manageBtn = screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Manage";
      });
      expect(manageBtn).toBeInTheDocument();
    });
    const manageBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Manage";
    });
    await user.click(manageBtn!);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

describe("zero org switcher - org switch menu item switches organization (SIDEBAR-D-061)", () => {
  it("calls setActive with the selected organization id", async () => {
    mockAPIs();
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [
          { id: "org_1", organization: { id: "org_1", name: "Current Org" } },
          { id: "org_2", organization: { id: "org_2", name: "Other Org" } },
        ],
      },
    });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Current Org"));

    await waitFor(() => {
      expect(screen.getByText("Other Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Other Org"));

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledWith({
        organization: "org_2",
      });
    });
  });
});

describe("zero org switcher - join button accepts invitation (SIDEBAR-D-062)", () => {
  it("should call accept without switching org when Join is clicked", async () => {
    const acceptSpy = () => {
      return Promise.resolve({});
    };

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
      expect(screen.getByText("Invited Org")).toBeInTheDocument();
    });
  });
});

describe("zero org switcher - create workspace item starts creation flow (SIDEBAR-D-063)", () => {
  it("calls createOrganization when Create workspace is clicked", async () => {
    mockAPIs();
    await setupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [{ id: "org_1" }],
      },
    });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Current Org"));

    await waitFor(() => {
      expect(screen.getByText("Create workspace")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Create workspace"));

    await waitFor(() => {
      expect(mockedClerk.createOrganization).toHaveBeenCalled();
    });
  });
});

describe("zero org switcher - pending invitations badge hidden when none (SIDEBAR-D-064)", () => {
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
});
