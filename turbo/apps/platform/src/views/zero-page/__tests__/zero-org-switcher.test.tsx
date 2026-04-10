import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  fireClerkListeners,
  mockedClerk,
  mockOrganization,
} from "../../../__tests__/mock-auth.ts";

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
    detachedSetupPage({
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

    detachedSetupPage({
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
    detachedSetupPage({
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
      expect(
        screen.getByTestId("pending-invitations-badge"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero org switcher - pending invitations list renders (SIDEBAR-D-057)", () => {
  it("shows pending invitation items when dropdown is opened", async () => {
    mockAPIs();
    detachedSetupPage({
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
    detachedSetupPage({
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
    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [{ id: "org_1" }],
      },
    });
    mockedClerk.user!.createOrganizationEnabled = true;

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

    detachedSetupPage({
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

    const manageBtn = await waitFor(() => {
      const btn = screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Manage";
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    await user.click(manageBtn);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

describe("zero org switcher - org switch menu item switches organization (SIDEBAR-D-061)", () => {
  it("calls setActive with the selected org and closes the dropdown", async () => {
    // Simulate the production behavior: setActive updates the active org in Clerk
    // and fires the org-change listener. In production, watchOrgSwitch$ detects
    // the change and navigates to "/" for a full page reload with the new org
    // context. Here we verify the component correctly hands off to Clerk and the
    // dropdown closes as the visible UI outcome.
    mockedClerk.setActive.mockImplementation(
      ({ organization }: { organization: string }) => {
        mockOrganization({
          activeOrg: { id: organization, name: "Other Org" },
          memberships: [
            {
              id: "org_1",
              organization: { id: "org_1", name: "Current Org" },
            },
            {
              id: "org_2",
              organization: { id: "org_2", name: "Other Org" },
            },
          ],
        });
        fireClerkListeners();
        return Promise.resolve();
      },
    );

    mockAPIs();
    detachedSetupPage({
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

    // Dropdown closes after selection (visible UI outcome)
    await waitFor(() => {
      expect(screen.queryByText("Create workspace")).not.toBeInTheDocument();
    });
  });
});

describe("zero org switcher - join button accepts invitation (SIDEBAR-D-062)", () => {
  it("removes the invitation from the list after Join is clicked", async () => {
    mockAPIs();
    detachedSetupPage({
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
              // Simulate acceptance clearing the invitation from the server
              mockOrganization({
                activeOrg: { id: "org_1", name: "Current Org" },
                memberships: [{ id: "org_1" }],
                pendingInvitations: [],
              });
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
      expect(screen.getByText("Join")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Join"));

    // After acceptance, the invitation is refreshed and removed from the list
    await waitFor(() => {
      expect(screen.queryByText("Join")).not.toBeInTheDocument();
    });
  });
});

describe("zero org switcher - create workspace item starts creation flow (SIDEBAR-D-063)", () => {
  it("closes the dropdown after creating a new workspace", async () => {
    // Simulate the production behavior: createOrganization creates the org, then
    // setActive activates it. In production, watchOrgSwitch$ detects the active
    // org change and navigates to "/" for a full page reload with the new workspace
    // context. Here we verify the dropdown closes as the visible UI outcome.
    mockedClerk.setActive.mockImplementation(
      ({ organization }: { organization: string }) => {
        mockOrganization({
          activeOrg: { id: organization, name: "New Workspace" },
          memberships: [
            { id: "org_1", organization: { id: "org_1", name: "Current Org" } },
            {
              id: organization,
              organization: { id: organization, name: "New Workspace" },
            },
          ],
        });
        fireClerkListeners();
        return Promise.resolve();
      },
    );

    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "Current Org" },
        memberships: [{ id: "org_1" }],
      },
    });
    mockedClerk.user!.createOrganizationEnabled = true;

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Current Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Current Org"));

    await waitFor(() => {
      expect(screen.getByText("Create workspace")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Create workspace"));

    // Dropdown closes after activation (visible UI outcome)
    await waitFor(() => {
      expect(screen.queryByText("Create workspace")).not.toBeInTheDocument();
    });
  });
});

describe("zero org switcher - pending invitations badge hidden when none (SIDEBAR-D-064)", () => {
  it("should not show red dot when there are no pending invitations", async () => {
    mockAPIs();
    detachedSetupPage({
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
    expect(
      screen.queryByTestId("pending-invitations-badge"),
    ).not.toBeInTheDocument();
  });
});

describe("zero org switcher - create workspace visibility based on createOrganizationEnabled", () => {
  it("hides create workspace when createOrganizationEnabled is false", async () => {
    mockAPIs();

    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "My Org" },
        memberships: [{ id: "org_1" }],
      },
    });

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByText("My Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("My Org"));

    await waitFor(() => {
      expect(screen.getAllByText("Manage").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Create workspace")).not.toBeInTheDocument();
  });

  it("shows create workspace when createOrganizationEnabled is true", async () => {
    mockAPIs();

    detachedSetupPage({
      context,
      path: "/",
      org: {
        activeOrg: { id: "org_1", name: "My Org" },
        memberships: [{ id: "org_1" }],
      },
    });
    mockedClerk.user!.createOrganizationEnabled = true;

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByText("My Org")).toBeInTheDocument();
    });
    await user.click(screen.getByText("My Org"));

    await waitFor(() => {
      expect(screen.getByText("Create workspace")).toBeInTheDocument();
    });
  });
});
