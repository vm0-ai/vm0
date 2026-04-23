import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { type OrgDomain, zeroOrgDomainsContract } from "@vm0/core";
import { setMockOrg, resetMockOrg } from "../../../mocks/handlers/api-org.ts";
import {
  setMockOrgDomains,
  resetMockOrgDomains,
} from "../../../mocks/handlers/api-org-domains.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

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

beforeEach(() => {
  resetMockOrg();
  resetMockOrgDomains();
});

async function openDomainsTab() {
  detachedSetupPage({ context, path: "/?settings=domains" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("org domains tab - display", () => {
  it("shows each domain's name in the list", async () => {
    // ORG-D-073
    setMockOrg({ slug: "test-org", name: "Test Org", role: "admin" });
    setMockOrgDomains([verifiedDomain, unverifiedDomain]);
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
    setMockOrg({ role: "admin" });
    await openDomainsTab();

    await waitFor(() => {
      expect(screen.queryAllByTestId("domain-row")).toHaveLength(0);
    });
  });
});

describe("org domains tab - display loading", () => {
  it("shows loading skeleton placeholders while domains load", async () => {
    // ORG-D-076
    setMockOrg({ role: "admin" });
    server.use(
      mockApi(zeroOrgDomainsContract.list, ({ never }) => {
        // Intentionally hangs until test teardown aborts the current signal.
        return never();
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
    setMockOrg({ role: "admin" });
    await openDomainsTab();

    await waitFor(() => {
      expect(screen.queryAllByTestId("domain-row")).toHaveLength(0);
    });

    click(screen.getByText(/Add domain/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add domain" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("example.com")).toBeInTheDocument();
  });

  it("shows all enrollment mode options in the dropdown", async () => {
    // ORG-I-079
    setMockOrg({ role: "admin" });
    await openDomainsTab();

    click(screen.getByText(/Add domain/i));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add domain" }),
      ).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog");
    click(within(dialog).getByRole("combobox"));

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
    setMockOrg({ role: "admin" });
    setMockOrgDomains([verifiedDomain]);
    await openDomainsTab();

    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });

    const row = screen.getByTestId("domain-row");
    click(within(row).getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/Unverify/i)).toBeInTheDocument();
      expect(screen.getByText(/Remove/i)).toBeInTheDocument();
    });
  });

  it("shows remove confirmation dialog when Remove is clicked from action menu", async () => {
    // ORG-I-081
    setMockOrg({ role: "admin" });
    setMockOrgDomains([verifiedDomain]);
    await openDomainsTab();

    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });

    const row = screen.getByTestId("domain-row");
    click(within(row).getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/Remove/i)).toBeInTheDocument();
    });
    click(screen.getByText(/Remove/i));

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
    setMockOrg({ role: "admin" });
    await openDomainsTab();

    click(screen.getByText(/Add domain/i));

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
    setMockOrg({ role: "member" });
    detachedSetupPage({ context, path: "/?settings=domains" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "General" }),
      ).toBeInTheDocument();
    });
  });
});
