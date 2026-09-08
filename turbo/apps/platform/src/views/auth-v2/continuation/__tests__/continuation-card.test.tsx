import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  type MockedMembership,
  type mockOrganization,
  mockedClerk,
} from "../../../../__tests__/mock-auth.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../../__tests__/page-helper.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../../signals/utils.ts";

const context = testContext();

function membership(
  id: string,
  name: string,
  imageUrl?: string,
): MockedMembership {
  return {
    id: `membership_${id}`,
    organization: { id, imageUrl, name },
    role: "org:member",
  };
}

function buttonNamed(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
}

function waitForButton(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const button = buttonNamed(name);
    if (!button) {
      throw new Error(`Expected button named ${name}`);
    }
    return button;
  });
}

function setupTaskPage(options: {
  readonly memberships?: MockedMembership[];
  readonly canCreate?: boolean;
  readonly creationLimit?: number;
  readonly pendingInvitations?: Parameters<
    typeof mockOrganization
  >[0]["pendingInvitations"];
  readonly taskKey: string;
  readonly url?: string;
}): Promise<void> {
  const memberships = options.memberships ?? [];
  const url = new URL(
    options.url ?? "https://app.okou.ai/sign-in/tasks/choose-organization",
  );
  return setupPage({
    auth: {
      organization: {
        activeOrg: null,
        memberships,
        pendingInvitations: options.pendingInvitations,
      },
      session: { token: "test-token" },
      user: {
        createOrganizationEnabled: options.canCreate ?? false,
        createOrganizationsLimit: options.creationLimit,
        clientSessions: [
          {
            currentTask: { key: options.taskKey },
            id: "session_pending",
            status: "pending",
            user: {
              fullName: "Test User",
              organizationMemberships: memberships,
              primaryEmailAddress: { emailAddress: "test@example.com" },
            },
          },
        ],
        fullName: "Test User",
        id: "user_test",
      },
    },
    context,
    host: url.hostname,
    path: `${url.pathname}${url.search}${url.hash}`,
  });
}

test("A pending session can choose an organization and continue", async () => {
  const user = userEvent.setup({ delay: null });
  const activation = createDeferredPromise<void>(context.signal);
  mockedClerk.setActive.mockImplementation(async (params) => {
    await activation.promise;
    await params.navigate?.({
      decorateUrl: (url) => {
        return url;
      },
      session: {
        id: "session_pending",
        status: "active",
        user: { organizationMemberships: [] },
      },
    });
  });
  await setupTaskPage({
    memberships: [
      membership(
        "org_alpha",
        "Alpha Company",
        "https://cdn.vm0.test/orgs/alpha.png",
      ),
      membership(
        "org_beta",
        "Beta Studio",
        "https://cdn.vm0.test/orgs/beta.png",
      ),
    ],
    taskKey: "choose-organization",
    url: `https://app.okou.ai/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent("https://app.okou.ai/agents")}`,
  });

  await screen.findByRole("heading", {
    name: "Choose an organization",
  });
  const alpha = await waitForButton("Continue with Alpha Company");
  const beta = await waitForButton("Continue with Beta Studio");
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Choose an organization" }),
    ).toHaveFocus();
  });
  expect(screen.getByRole("img", { name: "Alpha Company" })).toHaveAttribute(
    "src",
    "https://cdn.vm0.test/orgs/alpha.png",
  );
  expect(screen.getByRole("img", { name: "Beta Studio" })).toHaveAttribute(
    "src",
    "https://cdn.vm0.test/orgs/beta.png",
  );
  expect(screen.getByText("Signed in as test@example.com")).toBeVisible();
  expect(document.body).not.toHaveTextContent("membership_org_alpha");
  expect(document.body).not.toHaveTextContent("org_beta");
  expect(screen.queryByText(/invitation/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/create organization/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/manage organization/i)).not.toBeInTheDocument();

  beta.focus();
  await user.keyboard("{Enter}{Enter}");

  await waitFor(() => {
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    expect(beta).toHaveAttribute("aria-busy", "true");
  });
  expect(beta).toHaveAccessibleName("Continue with Beta Studio");
  expect(alpha).toBeDisabled();
  expect(alpha).toHaveAttribute("aria-busy", "false");
  expect(alpha).toHaveTextContent("Alpha Company");
  expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);

  await act(async () => {
    activation.resolve(undefined);
    await activation.promise;
  });

  await waitFor(() => {
    expect(location.pathname).toBe("/agents");
  });
});

test("Organization activation failure shows a sanitized recovery path", async () => {
  mockedClerk.setActive.mockRejectedValue(
    new Error("token=secret membership_private https://sensitive.example"),
  );
  await setupTaskPage({
    memberships: [membership("org_private", "Private Workspace")],
    taskKey: "choose-organization",
  });

  const privateWorkspace = await waitForButton(
    "Continue with Private Workspace",
  );
  click(privateWorkspace);

  await screen.findByRole("heading", {
    name: "Sign-in couldn't be completed",
  });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", {
        name: "Sign-in couldn't be completed",
      }),
    ).toHaveFocus();
  });
  expect(buttonNamed("Start over")).toBeVisible();
  expect(document.body).not.toHaveTextContent("token=secret");
  expect(document.body).not.toHaveTextContent("membership_private");
  expect(document.body).not.toHaveTextContent("sensitive.example");
});

test("A pending session with no memberships cannot create an organization from sign-in", async () => {
  await setupTaskPage({ memberships: [], taskKey: "choose-organization" });

  await expect(
    screen.findByRole("heading", {
      name: "No organization available",
    }),
  ).resolves.toBeVisible();
  expect(buttonNamed("Start over")).toBeVisible();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return /create/i.test(button.textContent ?? "");
    }),
  ).toBeFalsy();
});

test("Unsupported continuation steps fail closed and can be restarted", async () => {
  const signOut = createDeferredPromise<void>(context.signal);
  mockedClerk.signOut.mockImplementation(() => {
    return signOut.promise;
  });
  await setupTaskPage({ taskKey: "future-sensitive-task" });

  await expect(
    screen.findByRole("heading", { name: "Sign-in step unavailable" }),
  ).resolves.toBeVisible();
  expect(document.body).not.toHaveTextContent("future-sensitive-task");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  const restart = await waitForButton("Start over");

  click(restart);
  click(restart);

  await waitFor(() => {
    expect(mockedClerk.signOut).toHaveBeenCalledTimes(1);
    expect(restart).toHaveAttribute("aria-busy", "true");
  });
  expect(restart).toHaveAccessibleName("Start over");
  expect(restart).toBeDisabled();
  expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);

  await act(async () => {
    signOut.resolve(undefined);
    await signOut.promise;
  });
});

test("A user without organizations can create one when Clerk allows it and retry only activation", async () => {
  const creation = createDeferredPromise<{ id: string }>(context.signal);
  mockedClerk.createOrganization.mockReturnValue(creation.promise);
  mockedClerk.setActive.mockRejectedValueOnce(
    new Error("activation-private-token"),
  );
  await setupTaskPage({
    canCreate: true,
    creationLimit: 0,
    taskKey: "choose-organization",
  });
  await fill(await screen.findByLabelText("Organization name"), "My new team");
  const create = await waitForButton("Create organization");
  click(create);
  click(create);
  await waitFor(() => {
    return expect(create).toBeDisabled();
  });
  expect(mockedClerk.createOrganization).toHaveBeenCalledExactlyOnceWith({
    name: "My new team",
  });
  await act(async () => {
    creation.resolve({ id: "org_created" });
    await creation.promise;
  });
  await screen.findByRole("alert");
  expect(document.body).not.toHaveTextContent("activation-private-token");
  click(await waitForButton("Continue with My new team"));
  await waitFor(() => {
    return expect(mockedClerk.setActive).toHaveBeenCalledTimes(2);
  });
  await screen.findByRole("heading", { name: "Sign-in complete" });
  expect(mockedClerk.createOrganization).toHaveBeenCalledTimes(1);
  expect(mockedClerk.setActive).toHaveBeenLastCalledWith(
    expect.objectContaining({ organization: "org_created" }),
  );
});

test("A user without an organization can accept an invitation even when creation is disabled", async () => {
  const accepted = createDeferredPromise<unknown>(context.signal);
  const accept = vi.fn<() => Promise<unknown>>(() => {
    return accepted.promise;
  });
  mockedClerk.setActive.mockRejectedValueOnce(new Error("activation failed"));
  await setupTaskPage({
    taskKey: "choose-organization",
    pendingInvitations: [
      {
        id: "invitation_one",
        publicOrganizationData: {
          id: "org_invited",
          name: "Invited team",
          imageUrl: "https://cdn.vm0.test/invited.png",
        },
        accept,
      },
    ],
  });
  const join = await waitForButton("Join Invited team");
  expect(buttonNamed("Create organization")).toBeUndefined();
  click(join);
  click(join);
  await waitFor(() => {
    return expect(join).toBeDisabled();
  });
  expect(accept).toHaveBeenCalledTimes(1);
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  await act(async () => {
    accepted.resolve(undefined);
    await accepted.promise;
  });
  await screen.findByRole("alert");
  click(await waitForButton("Continue with Invited team"));
  await screen.findByRole("heading", { name: "Sign-in complete" });
  expect(accept).toHaveBeenCalledTimes(1);
  expect(mockedClerk.setActive).toHaveBeenLastCalledWith(
    expect.objectContaining({ organization: "org_invited" }),
  );
});
