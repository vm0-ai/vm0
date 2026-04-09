import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type { OrgDomain } from "@vm0/core";

const context = testContext();

const verifiedDomain = {
  id: "dom_1",
  name: "example.com",
  enrollmentMode: "manual_invitation",
  verification: { status: "verified", strategy: "dns" },
  createdAt: "2026-01-15T00:00:00Z",
} as const satisfies OrgDomain;

const unverifiedDomain = {
  id: "dom_2",
  name: "other.org",
  enrollmentMode: "automatic_invitation",
  verification: { status: "unverified", strategy: "dns" },
  createdAt: "2026-02-20T00:00:00Z",
} as const satisfies OrgDomain;

function mockAPIs(domains: OrgDomain[] = [], overrides?: { role?: string }) {
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
    http.get("*/api/zero/org/logo", () => {
      return HttpResponse.json({ logoUrl: null });
    }),
    http.get("*/api/zero/org/domains", () => {
      return HttpResponse.json({ domains });
    }),
  );
}

async function openDomainsTab() {
  detachedSetupPage({ context, path: "/?settings=domains" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("org domains tab - display", () => {
  it("shows each domain's name in the list", async () => {
    // ORG-D-073
    mockAPIs([verifiedDomain, unverifiedDomain]);
    await openDomainsTab();

    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });

    expect(screen.getByText("other.org")).toBeInTheDocument();
  });
});

describe("org domains tab - conditional", () => {
  it("shows empty state when no domains exist", async () => {
    // ORG-C-075
    mockAPIs([]);
    await openDomainsTab();

    await waitFor(() => {
      expect(screen.queryAllByTestId("domain-row")).toHaveLength(0);
    });
  });
});

describe("org domains tab - display loading", () => {
  it("shows loading skeleton placeholders while domains load", async () => {
    // ORG-D-076
    mockAPIs([]);
    server.use(
      http.get("*/api/zero/org/domains", () => {
        return new Promise<Response>(() => {
          // intentionally never resolves to keep loading state
        });
      }),
    );

    detachedSetupPage({ context, path: "/?settings=domains" });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    const skeletons = screen.getAllByTestId("domain-skeleton");
    expect(skeletons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("org domains tab - interaction", () => {
  it("opens add domain dialog with input field when 'Add domain' button is clicked", async () => {
    // ORG-I-077
    const user = userEvent.setup();
    mockAPIs([]);
    await openDomainsTab();

    await waitFor(() => {
      expect(screen.queryAllByTestId("domain-row")).toHaveLength(0);
    });

    await user.click(screen.getByText(/Add domain/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add domain" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("example.com")).toBeInTheDocument();
  });

  it("shows all enrollment mode options in the dropdown", async () => {
    // ORG-I-079
    const user = userEvent.setup();
    mockAPIs([]);
    await openDomainsTab();

    await user.click(screen.getByText(/Add domain/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add domain" }),
      ).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("combobox"));

    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /Manual invitation/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: /Automatic invitation/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: /Automatic suggestion/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows verify/unverify and remove options in the domain action menu", async () => {
    // ORG-I-080
    const user = userEvent.setup();
    mockAPIs([verifiedDomain]);
    await openDomainsTab();

    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });

    const row = screen.getByTestId("domain-row");
    await user.click(within(row).getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/Unverify/i)).toBeInTheDocument();
      expect(screen.getByText(/Remove/i)).toBeInTheDocument();
    });
  });

  it("shows remove confirmation dialog when Remove is clicked from action menu", async () => {
    // ORG-I-081
    const user = userEvent.setup();
    mockAPIs([verifiedDomain]);
    await openDomainsTab();

    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });

    const row = screen.getByTestId("domain-row");
    await user.click(within(row).getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/Remove/i)).toBeInTheDocument();
    });
    await user.click(screen.getByText(/Remove/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Remove domain?" }),
      ).toBeInTheDocument();
    });
  });
});

describe("org domains tab - validation", () => {
  it("disables the submit button when domain input has invalid format", async () => {
    // ORG-V-078
    const user = userEvent.setup();
    mockAPIs([]);
    await openDomainsTab();

    await user.click(screen.getByText(/Add domain/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add domain" }),
      ).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("example.com");
    await user.type(input, "invaliddomain");

    const dialog = screen.getByRole("dialog");
    const submitBtn = within(dialog)
      .getAllByRole("button")
      .find((btn) => {
        return btn.textContent === "Add domain";
      });
    expect(submitBtn).toBeDefined();
    expect(submitBtn).toBeDisabled();
  });
});

describe("org domains tab - access control", () => {
  it("redirects non-admin users to the general tab when navigating to domains", async () => {
    mockAPIs([], { role: "member" });
    detachedSetupPage({ context, path: "/?settings=domains" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "General" }),
      ).toBeInTheDocument();
    });
  });
});
