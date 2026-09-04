import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  type MockedClientSession,
  type MockedMembership,
  mockClerkSessionSignedOut,
  mockedClerk,
  mockSignInResource,
} from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

interface AuthorizationState {
  enabledConnectorSlugs: string[];
}

function recoveryAgent() {
  return {
    agentId: AGENT_ID,
    avatarUrl: null,
    description: "Reviews authentication recovery",
    displayName: "Recovery Agent",
    modelProviderId: null,
    ownerId: "test-user-123",
    preferPersonalProvider: false,
    selectedModel: null,
    sound: null,
    visibility: "private" as const,
  };
}

function connectedGitHub(): PublicConnectorCatalogStatusItem {
  return {
    slug: "github",
    label: "GitHub",
    description: "Connect your GitHub account to access repositories.",
    icon: {
      url: "https://icons.example.test/github.svg",
      invertInDarkMode: false,
    },
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: {
      authMethod: "oauth",
      externalUsername: "octocat",
      externalEmail: null,
      reconnectReason: null,
    },
    connected: true,
    connectionStatus: "connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

function setupAgentPage(options: {
  readonly authorizationState?: AuthorizationState;
  readonly tab: "authorization" | "profile";
}): Promise<void> {
  context.mocks.data.agents([recoveryAgent()]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, recoveryAgent());
  });
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [connectedGitHub()] });
  });
  if (options.authorizationState) {
    context.mocks.http.get("*/api/agents/:id/user-connectors", () => {
      return HttpResponse.json({
        enabledConnectorSlugs:
          options.authorizationState?.enabledConnectorSlugs ?? [],
      });
    });
  }
  return setupPage({
    context,
    host: "app.vm0.ai",
    path: `/agents/${AGENT_ID}?tab=${options.tab}`,
  });
}

function currentGitHubAccessSwitch(): HTMLElement {
  const accessSwitch = Array.from(
    document.querySelectorAll<HTMLElement>('[role="switch"]'),
  ).find((candidate) => {
    return candidate.getAttribute("aria-label")?.includes("GitHub access");
  });
  if (!accessSwitch) {
    throw new Error("Expected the GitHub access switch");
  }
  return accessSwitch;
}

async function setupAuthorizationPage(
  authorizationState: AuthorizationState,
): Promise<HTMLElement> {
  await setupAgentPage({ authorizationState, tab: "authorization" });
  await expect(
    screen.findByRole("heading", { name: "Recovery Agent" }),
  ).resolves.toBeInTheDocument();
  return waitFor(() => {
    return currentGitHubAccessSwitch();
  });
}

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

function pendingUser(
  memberships: MockedMembership[],
  taskKey: string,
): {
  readonly clientSessions: MockedClientSession[];
  readonly fullName: string;
  readonly id: string;
} {
  return {
    clientSessions: [
      {
        currentTask: { key: taskKey },
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
  };
}

function setupTaskPage(options: {
  readonly memberships?: MockedMembership[];
  readonly path?: string;
  readonly taskKey: string;
}): Promise<void> {
  const memberships = options.memberships ?? [];
  return setupPage({
    context,
    host: "app.vm0.ai",
    path: options.path ?? "/sign-in/tasks/choose-organization",
    auth: {
      organization: { activeOrg: null, memberships },
      session: { token: "test-token" },
      user: pendingUser(memberships, options.taskKey),
    },
  });
}

function buttonNamed(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
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

test("A confirmed sign-out remains silent during request recovery", async () => {
  const user = userEvent.setup({ delay: null });
  const requestCanFinish = context.mocks.deferred<void>();
  let requests = 0;
  context.mocks.http.put("*/api/agents/:id/user-connectors", async () => {
    requests += 1;
    await requestCanFinish.promise;
    return HttpResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  });
  const accessSwitch = await setupAuthorizationPage({
    enabledConnectorSlugs: [],
  });

  await user.click(accessSwitch);
  await waitFor(() => {
    expect(requests).toBe(1);
  });
  mockClerkSessionSignedOut(true);
  const forcedRefreshesAtSignOut =
    mockedClerk.sessionGetToken.mock.calls.filter(([options]) => {
      return options?.skipCache === true;
    }).length;
  await act(async () => {
    requestCanFinish.resolve();
    await requestCanFinish.promise;
  });

  await waitFor(() => {
    expect(requests).toBe(1);
    expect(
      mockedClerk.sessionGetToken.mock.calls.filter(([options]) => {
        return options?.skipCache === true;
      }),
    ).toHaveLength(forcedRefreshesAtSignOut);
  });
  expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
});

test("Repeated workspace selection completes only once", async () => {
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
      membership("org_alpha", "Alpha Company"),
      membership("org_beta", "Beta Studio"),
    ],
    path: `/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent("https://app.vm0.ai/agents")}`,
    taskKey: "choose-organization",
  });
  const beta = await waitForButton("Continue with Beta Studio");

  click(beta);
  click(beta);

  await waitFor(() => {
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    expect(beta).toHaveAttribute("aria-busy", "true");
  });
  await act(async () => {
    activation.resolve();
    await activation.promise;
  });
  await waitFor(() => {
    expect(location.pathname).toBe("/agents");
  });
});

test("A protected page routes a member to workspace choice", async () => {
  const memberships = [membership("org_alpha", "Alpha Company")];
  await startPage({
    context,
    host: "app.vm0.ai",
    path: "/agents",
    auth: {
      organization: { activeOrg: null, memberships },
      session: { token: "test-token" },
      user: pendingUser(memberships, "choose-organization"),
    },
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
    expect(location.pathname).toBe("/sign-in/tasks/choose-organization");
  });
});

test("Refreshing an authentication task restores workspace selection", async () => {
  await setupTaskPage({
    memberships: [membership("org_alpha", "Alpha Company")],
    path: "/sign-in#/tasks/choose-organization?attempt=1",
    taskKey: "choose-organization",
  });

  await expect(
    screen.findByRole("heading", { name: "Choose an organization" }),
  ).resolves.toBeInTheDocument();
  await expect(
    waitForButton("Continue with Alpha Company"),
  ).resolves.toBeVisible();
  expect(location.hash).toBe("#/tasks/choose-organization?attempt=1");
});

test("Session activation failure is shown without automatic retries", async () => {
  mockSignInResource({
    createdSessionId: "session_private",
    status: "complete",
  });
  mockedClerk.setActive.mockRejectedValue(
    new Error("sensitive session activation response"),
  );
  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-in",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Sign-in couldn't be completed" }),
  ).resolves.toBeInTheDocument();
  expect(buttonNamed("Start over")).toBeVisible();
  expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  expect(document.body).not.toHaveTextContent("sensitive session");
});

test("Sign-up keeps ownership of a required workspace task", async () => {
  await setupTaskPage({
    memberships: [membership("org_alpha", "Alpha Company")],
    path: "/sign-up/tasks/choose-organization",
    taskKey: "choose-organization",
  });

  await expect(
    screen.findByRole("heading", { name: "Choose an organization" }),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/sign-up/tasks/choose-organization");
  await expect(
    waitForButton("Continue with Alpha Company"),
  ).resolves.toBeVisible();
});

test("Unsupported authentication tasks fail safely", async () => {
  await setupTaskPage({ taskKey: "future-sensitive-task" });

  await expect(
    screen.findByRole("heading", { name: "Sign-in step unavailable" }),
  ).resolves.toBeInTheDocument();
  expect(buttonNamed("Start over")).toBeVisible();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  expect(document.body).not.toHaveTextContent("future-sensitive-task");
});

test("Workspace activation failure is shown without automatic retries", async () => {
  mockedClerk.setActive.mockRejectedValue(
    new Error("sensitive organization activation response"),
  );
  await setupTaskPage({
    memberships: [membership("org_private", "Private Workspace")],
    taskKey: "choose-organization",
  });
  const workspace = await waitForButton("Continue with Private Workspace");

  click(workspace);

  await expect(
    screen.findByRole("heading", { name: "Sign-in couldn't be completed" }),
  ).resolves.toBeInTheDocument();
  expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  expect(buttonNamed("Start over")).toBeVisible();
  expect(document.body).not.toHaveTextContent("sensitive organization");
});

test("Workspace selection shows only the user's current memberships", async () => {
  const user = userEvent.setup({ delay: null });
  await setupTaskPage({
    memberships: [
      membership(
        "org_alpha",
        "Alpha Company",
        "https://cdn.vm0.test/orgs/alpha.png",
      ),
      membership("org_beta", "Beta Studio"),
    ],
    taskKey: "choose-organization",
  });

  const alpha = await waitForButton("Continue with Alpha Company");
  const beta = await waitForButton("Continue with Beta Studio");
  expect(screen.getByRole("img", { name: "Alpha Company" })).toHaveAttribute(
    "src",
    "https://cdn.vm0.test/orgs/alpha.png",
  );
  expect(beta).toHaveTextContent("B");
  expect(document.body).not.toHaveTextContent("membership_org_alpha");
  expect(document.body).not.toHaveTextContent("create organization");

  alpha.focus();
  await user.keyboard("{Tab}");

  expect(beta).toHaveFocus();
});

test("A required workspace task fails safely when no workspace is available", async () => {
  await setupTaskPage({ memberships: [], taskKey: "choose-organization" });

  await expect(
    screen.findByRole("heading", { name: "No organization available" }),
  ).resolves.toBeInTheDocument();
  expect(buttonNamed("Start over")).toBeVisible();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return /create/i.test(button.textContent ?? "");
    }),
  ).toBeFalsy();
});
