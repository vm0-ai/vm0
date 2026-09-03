import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import type { MockedMembership } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function setBrowserUrl(url: string): void {
  context.mocks.browser.url(url);
}

function okouBrandLink(): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === "Go to Okou home";
  });
  if (!link) {
    throw new Error("Okou brand link not found");
  }
  return link;
}

function authV2Button(name: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Auth v2 button not found");
  }
  return button;
}

function setupChooseOrganizationPage(
  path: string,
  organization: { readonly id: string; readonly name: string },
): void {
  const membership: MockedMembership = {
    id: `membership_${organization.id}`,
    organization,
    role: "org:member",
  };
  detachedSetupPage({
    context,
    org: { activeOrg: null, memberships: [membership] },
    path,
    user: {
      clientSessions: [
        {
          currentTask: { key: "choose-organization" },
          id: "session_pending",
          status: "pending",
          user: {
            fullName: "Test User",
            organizationMemberships: [membership],
          },
        },
      ],
      fullName: "Test User",
      id: "test-user-123",
    },
  });
}

describe("app auth routes", () => {
  it.each([
    {
      documentTitle: "Sign in | VM0",
      heading: "Sign in to VM0",
      path: "/sign-in",
    },
    {
      documentTitle: "Sign up | VM0",
      heading: "Create your account",
      path: "/sign-up",
    },
    {
      documentTitle: "Sign up | VM0",
      heading: "Create your account",
      path: "/sign-up/verify-email-address",
    },
  ])("renders Auth v2 at the stable route $path", async (routeCase) => {
    setBrowserUrl(`https://app.vm0.ai${routeCase.path}`);

    detachedSetupPage({ context, path: routeCase.path });

    await expect(
      screen.findByRole("region", { name: routeCase.heading }),
    ).resolves.toBeVisible();
    expect(screen.getByTestId("app-auth-v2")).toBeVisible();
    expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.title).toBe(routeCase.documentTitle);
  });

  it("recovers forced organization selection on a stable task route", async () => {
    const path = "/sign-in/tasks/choose-organization";
    setBrowserUrl(`https://app.vm0.ai${path}`);

    setupChooseOrganizationPage(path, {
      id: "org_route",
      name: "Route Organization",
    });

    await expect(
      screen.findByRole("region", { name: "Choose an organization" }),
    ).resolves.toBeVisible();
    expect(authV2Button("Continue with Route Organization")).toBeVisible();
    expect(screen.queryByText(/create organization/i)).not.toBeInTheDocument();
    expect(document.title).toBe("Sign in | VM0");
  });

  it("preserves branded auth intent through stable-route continuation", async () => {
    const redirectUrl = "https://app.okou.ai/onboarding?source=auth-v2";
    const hash = "#/?step=identifier";
    const path = `/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent(redirectUrl)}${hash}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    setupChooseOrganizationPage(path, {
      id: "org_okou",
      name: "Okou Organization",
    });

    await expect(
      screen.findByRole("region", { name: "Choose an organization" }),
    ).resolves.toBeVisible();
    expect(document.body).toHaveTextContent(
      "Choose an organization to continue to Okou.",
    );
    expect(document.title).toBe("Sign in | Okou");
    expect(okouBrandLink()).toHaveAttribute("href", "https://app.okou.ai");
    fireEvent.click(authV2Button("Continue with Okou Organization"));

    await waitFor(() => {
      expect(location.href).toBe(redirectUrl);
    });
  });
});
