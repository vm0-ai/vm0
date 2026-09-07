import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import type { MockedMembership } from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { platformOkouWordmarkDarkImg } from "../../../lib/static-assets.ts";
import { pushState } from "../../../signals/location.ts";

const context = testContext();

function authV2Button(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named ${name}`);
  }
  return button;
}

function setupChooseOrganizationPage(
  currentContext: TestContext,
  path: string,
  organization: { readonly id: string; readonly name: string },
): Promise<void> {
  const membership: MockedMembership = {
    id: `membership_${organization.id}`,
    organization,
    role: "org:member",
  };
  return setupPage({
    context: currentContext,
    host: "app.vm0.ai",
    path,
    auth: {
      organization: { activeOrg: null, memberships: [membership] },
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
    },
  });
}

test("Branded organization selection continues to the trusted destination", async () => {
  context.mocks.browser.matchMedia(false);
  const redirectUrl = "https://app.okou.ai/onboarding?source=auth-v2";
  const path = `/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent(
    redirectUrl,
  )}#/?step=identifier`;
  await setupChooseOrganizationPage(context, path, {
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
  const brandLink = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === "Go to Okou home";
  });
  if (!brandLink) {
    throw new Error("Expected the Okou home link");
  }
  expect(brandLink).toHaveAttribute("href", "https://app.okou.ai");
  expect(screen.getByRole("img", { name: "Okou" })).toHaveAttribute(
    "src",
    platformOkouWordmarkDarkImg,
  );

  click(authV2Button("Continue with Okou Organization"));

  await waitFor(() => {
    expect(location.href).toBe(redirectUrl);
  });
});

test("A pending session can choose its required organization", async () => {
  await setupChooseOrganizationPage(
    context,
    "/sign-in/tasks/choose-organization",
    {
      id: "org_route",
      name: "Route Organization",
    },
  );

  await expect(
    screen.findByRole("region", { name: "Choose an organization" }),
  ).resolves.toBeVisible();
  expect(authV2Button("Continue with Route Organization")).toBeVisible();
  expect(screen.queryByText(/create organization/i)).not.toBeInTheDocument();
  expect(document.title).toBe("Sign in | VM0");
});

test("Stable authentication routes show the correct experience", async () => {
  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-in",
    auth: null,
  });
  await expect(
    screen.findByRole("region", { name: "Sign in to VM0" }),
  ).resolves.toBeVisible();
  expect(document.title).toBe("Sign in | VM0");

  const signUp = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === "Sign up";
  });
  if (!signUp) {
    throw new Error("Expected Sign up link");
  }
  click(signUp);
  await waitFor(() => {
    expect(
      screen.getByRole("region", { name: "Create your account" }),
    ).toBeVisible();
    expect(document.title).toBe("Sign up | VM0");
  });

  pushState(null, "", "/sign-up/verify-email-address");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => {
    expect(
      screen.getByRole("region", { name: "Create your account" }),
    ).toBeVisible();
    expect(document.title).toBe("Sign up | VM0");
  });
  expect(screen.getByTestId("app-auth-v2")).toBeVisible();
  expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
});
