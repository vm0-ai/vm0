import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  type MockedMembership,
  mockedClerk,
  mockSignInResource,
} from "../../../../__tests__/mock-auth.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../../__tests__/page-helper.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function membership(id: string, name: string): MockedMembership {
  return {
    id: `membership_${id}`,
    organization: { id, name },
    role: "org:member",
  };
}

function buttonNamed(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

async function waitForButton(name: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(buttonNamed(name)).toBeDefined();
  });
  const button = buttonNamed(name);
  if (!button) {
    throw new Error(`Expected button named ${name}`);
  }
  return button;
}

function setupTaskPage(options: {
  readonly memberships?: MockedMembership[];
  readonly taskKey: string;
  readonly url?: string;
}): void {
  const memberships = options.memberships ?? [];
  const url = new URL(
    options.url ?? "https://app.vm0.ai/v2/sign-in/tasks/choose-organization",
  );
  context.mocks.browser.url(url.toString());
  detachedSetupPage({
    context,
    org: { activeOrg: null, memberships },
    path: `${url.pathname}${url.search}${url.hash}`,
    session: { token: "test-token" },
    user: {
      clientSessions: [
        {
          currentTask: { key: options.taskKey },
          id: "session_pending",
          status: "pending",
          user: {
            fullName: "Test User",
            organizationMemberships: memberships,
          },
        },
      ],
      fullName: "Test User",
      id: "user_test",
    },
  });
}

describe("auth v2 continuation card", () => {
  it("recovers forced selection, switches membership once, and exposes no organization management", async () => {
    const user = userEvent.setup({ delay: null });
    const memberships = [
      membership("org_alpha", "Alpha Company"),
      membership("org_beta", "Beta Studio"),
    ];
    setupTaskPage({
      memberships,
      taskKey: "choose-organization",
      url: `https://app.vm0.ai/v2/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent("https://app.vm0.ai/agents")}`,
    });

    const beta = await waitForButton("Continue with Beta Studio");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Choose an organization" }),
    );
    expect(buttonNamed("Continue with Alpha Company")).toBeVisible();
    expect(screen.queryByText(/create organization/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/invitation/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/manage organization/i)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("membership_org_alpha");
    expect(document.body).not.toHaveTextContent("org_beta");

    beta.focus();
    await user.keyboard("{Enter}{Enter}");

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      organization: "org_beta",
    });
    await waitFor(() => {
      expect(location.pathname).toBe("/agents");
    });
  });

  it("shows a sanitized recovery path after organization activation failure", async () => {
    setupTaskPage({
      memberships: [membership("org_private", "Private Workspace")],
      taskKey: "choose-organization",
    });
    mockedClerk.setActive.mockRejectedValue(
      new Error("token=secret membership_private https://sensitive.example"),
    );

    fireEvent.click(await waitForButton("Continue with Private Workspace"));

    const heading = await screen.findByRole("heading", {
      name: "Sign-in couldn't be completed",
    });
    expect(heading).toBeVisible();
    expect(document.activeElement).toBe(heading);
    expect(buttonNamed("Start over")).toBeVisible();
    expect(document.body).not.toHaveTextContent("token=secret");
    expect(document.body).not.toHaveTextContent("membership_private");
    expect(document.body).not.toHaveTextContent("sensitive.example");
  });

  it("does not offer organization creation when no membership is available", async () => {
    setupTaskPage({ memberships: [], taskKey: "choose-organization" });

    await expect(
      screen.findByRole("heading", { name: "No organization available" }),
    ).resolves.toBeVisible();
    expect(buttonNamed("Start over")).toBeVisible();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return /create/i.test(button.textContent ?? "");
      }),
    ).toBeFalsy();
  });

  it.each([
    {
      description: "an unsupported continuation",
      expectedTitle: "Sign-in step unavailable",
      taskKey: "reset-password",
    },
    {
      description: "an unknown task",
      expectedTitle: "Sign-in step unavailable",
      taskKey: "future-sensitive-task",
    },
    {
      description: "a returned second-factor task",
      expectedTitle: "Additional verification required",
      taskKey: "setup-mfa",
    },
  ])("fails closed for $description", async ({ expectedTitle, taskKey }) => {
    setupTaskPage({ taskKey });

    await expect(
      screen.findByRole("heading", { name: expectedTitle }),
    ).resolves.toBeVisible();
    expect(buttonNamed("Start over")).toBeVisible();
    expect(document.body).not.toHaveTextContent(taskKey);
    expect(mockedClerk.setActive).not.toHaveBeenCalled();
  });

  it("fails closed when Clerk returns a second-factor sign-in status", async () => {
    mockSignInResource({ status: "needs_second_factor" });
    context.mocks.browser.url("https://app.vm0.ai/v2/sign-in/factor-two");
    detachedSetupPage({
      context,
      path: "/v2/sign-in/factor-two",
      session: null,
      user: null,
    });

    await expect(
      screen.findByRole("heading", {
        name: "Additional verification required",
      }),
    ).resolves.toBeVisible();
    expect(buttonNamed("Start over")).toBeVisible();
  });
});
