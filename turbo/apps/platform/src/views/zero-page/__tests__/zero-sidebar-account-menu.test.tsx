import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { splitChatThreadListResponse } from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function prepareDefaultAgent(): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

async function openAccountMenu(): Promise<HTMLElement> {
  const accountName = await screen.findByText("Alex Rivera");
  const accountButton = accountName.closest("button");
  if (!accountButton) {
    throw new Error("Account menu trigger not found");
  }
  click(accountButton);
  return screen.findByRole("menu");
}

function mockAdminAccountSidebar(): void {
  prepareDefaultAgent();
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(chatThreadsContract.list, ({ respond }) => {
    return respond(200, splitChatThreadListResponse([]));
  });
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, {
      tier: "pro",
      credits: 12_500,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: {
        expiringNextCycle: 0,
        nextExpiryDate: null,
      },
      creditBreakdown: [
        {
          category: "plan",
          tier: "pro",
          label: "Pro credits",
          credits: 10_000,
        },
        {
          category: "promotional",
          label: "Launch bonus",
          credits: 2500,
        },
      ],
      creditGrants: [],
    });
  });
}

describe("zero sidebar account menu", () => {
  it("opens credit balance and export data from the account menu", async () => {
    mockAdminAccountSidebar();
    const openMock = context.mocks.browser.open(null);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.DataExport]: true },
    });

    let menu = await openAccountMenu();

    await waitFor(() => {
      expect(within(menu).getByText("12,500 credits")).toBeInTheDocument();
      expect(within(menu).getByText("Export data")).toBeInTheDocument();
    });

    click(within(menu).getByText("Export data"));

    await waitFor(() => {
      expect(
        openMock.calls.some((call) => {
          return call.url?.endsWith("/export") ?? false;
        }),
      ).toBeTruthy();
    });

    menu = await openAccountMenu();
    click(within(menu).getByText("12,500 credits"));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Credit balance" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Pro credits")).toBeInTheDocument();
      expect(screen.getByText("Launch bonus")).toBeInTheDocument();
    });
  });

  it("opens memory from the account menu", async () => {
    mockAdminAccountSidebar();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    const menu = await openAccountMenu();
    click(within(menu).getByText("Memory"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Memory" }),
      ).toBeInTheDocument();
      expect(screen.getByText("No updates yet")).toBeInTheDocument();
    });
  });

  it("opens settings from the account menu and changes debug capture", async () => {
    prepareDefaultAgent();
    context.mocks.data.userPreferences({
      captureNetworkBodiesRemaining: 0,
    });
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New chat with Zero")).toBeInTheDocument();
    });
    const accountName = await screen.findByText("Alex Rivera");
    const accountButton = accountName.closest("button");
    if (!accountButton) {
      throw new Error("Account menu trigger not found");
    }

    click(accountButton);

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Alex Rivera")).toBeInTheDocument();
    expect(
      within(menu).getByText("alex.rivera@example.test"),
    ).toBeInTheDocument();

    click(within(menu).getByText("Settings"));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Preference" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Account & Security")).toBeInTheDocument();
      expect(screen.getByText("Alex Rivera")).toBeInTheDocument();
      expect(screen.getByText("alex.rivera@example.test")).toBeInTheDocument();
    });

    click(buttonByText("Manage"));

    await waitFor(() => {
      expect(mockedClerk.openUserProfile).toHaveBeenCalledWith({
        apiKeysProps: { hide: true },
      });
    });

    const clerkProfileModal = document.createElement("div");
    clerkProfileModal.dataset.clerkUserProfile = "";
    document.body.append(clerkProfileModal);
    await waitFor(() => {
      expect(clerkProfileModal).toBeInTheDocument();
    });
    clerkProfileModal.remove();

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
    });

    click(buttonByText("Debug"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Debug" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(
        screen.getByText("Enabled for the next 3 runs"),
      ).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });
  });

  it("shows account switching, add-account, and sign-out actions", async () => {
    prepareDefaultAgent();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
        imageUrl: "https://cdn.vm0.test/users/alex.png",
        clientSessions: [
          {
            id: "test-session-id",
            status: "active",
            user: {
              fullName: "Alex Rivera",
              imageUrl: "https://cdn.vm0.test/users/alex.png",
              primaryEmailAddress: {
                emailAddress: "alex.rivera@example.test",
              },
            },
          },
          {
            id: "session-jamie",
            status: "active",
            user: {
              fullName: "Jamie Chen",
              imageUrl: "https://cdn.vm0.test/users/jamie.png",
              primaryEmailAddress: {
                emailAddress: "jamie.chen@example.test",
              },
            },
          },
        ],
      },
    });

    let menu = await openAccountMenu();
    click(within(menu).getByText("Switch account"));

    await waitFor(() => {
      expect(screen.getByText("Jamie Chen")).toBeInTheDocument();
      expect(screen.getByText("jamie.chen@example.test")).toBeInTheDocument();
      expect(screen.getByText("Add account")).toBeInTheDocument();
    });

    click(screen.getByText("Add account"));
    await waitFor(() => {
      expect(mockedClerk.openSignIn).toHaveBeenCalledWith();
    });

    menu = await openAccountMenu();
    click(within(menu).getByText("Switch account"));
    click(await screen.findByText("Jamie Chen"));

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledWith(
        expect.objectContaining({ session: "session-jamie" }),
      );
    });

    menu = await openAccountMenu();
    click(within(menu).getByText("Sign out"));

    await waitFor(() => {
      expect(mockedClerk.signOut).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "test-session-id",
          redirectUrl: expect.stringContaining("/sign-in?redirect_url="),
        }),
      );
    });
  });
});
