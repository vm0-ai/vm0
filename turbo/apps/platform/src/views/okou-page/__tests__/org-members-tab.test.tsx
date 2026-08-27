import type { OrgMembersResponse } from "@okouai/api-contracts/contracts/org-members";
import {
  orgInviteContract,
  orgMembersContract,
  orgMembershipRequestsContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackManagementContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "@okouai/ui/components/ui/sonner";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

// Keep runtime route-import transforms outside assertion timeouts. This file
// exercises only the home route; production still resolves this module only
// after matching a home route.
import "../../../signals/route-setups/home.ts";

const context = testContext();

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function buttonByLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function mockMembersStory(): {
  readonly addPendingInvitation: (
    invitation: NonNullable<OrgMembersResponse["pendingInvitations"]>[number],
  ) => void;
  readonly membersRequestCount: () => number;
} {
  let membersRequestCount = 0;
  let response: OrgMembersResponse = {
    name: "Test Org",
    role: "admin",
    createdAt: "2026-01-01T00:00:00Z",
    members: [
      {
        userId: "test-user-123",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Admin",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00Z",
      },
      {
        userId: "user-bob",
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Member",
        imageUrl: "https://example.test/bob.png",
        role: "member",
        joinedAt: "2026-01-02T00:00:00Z",
      },
      {
        userId: "user-eve",
        email: "eve@example.com",
        firstName: "Eve",
        lastName: "Admin",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-02T12:00:00Z",
      },
    ],
    pendingInvitations: [
      {
        id: "inv-pending",
        email: "pending@example.com",
        role: "member",
        createdAt: "2026-01-03T00:00:00Z",
      },
    ],
    membershipRequests: [
      {
        id: "req-carol",
        userId: "user-carol",
        email: "carol@example.com",
        firstName: "Carol",
        lastName: "Request",
        imageUrl: "",
        createdAt: "2026-01-04T00:00:00Z",
      },
      {
        id: "req-dan",
        userId: "user-dan",
        email: "dan@example.com",
        firstName: "Dan",
        lastName: "Reject",
        imageUrl: "",
        createdAt: "2026-01-05T00:00:00Z",
      },
    ],
  };

  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(orgMembersContract.members, ({ respond }) => {
    membersRequestCount += 1;
    return respond(200, response);
  });
  context.mocks.api(orgInviteContract.invite, ({ body, respond }) => {
    response = {
      ...response,
      pendingInvitations: [
        ...(response.pendingInvitations ?? []),
        {
          id: "inv-new",
          email: body.email,
          role: body.role,
          createdAt: "2026-01-05T00:00:00Z",
        },
      ],
    };
    return respond(200, { message: "Invitation sent" });
  });
  context.mocks.api(orgInviteContract.revoke, ({ body, respond }) => {
    response = {
      ...response,
      pendingInvitations: response.pendingInvitations?.filter((candidate) => {
        return candidate.id !== body.invitationId;
      }),
    };
    return respond(200, { message: "Invitation revoked" });
  });
  context.mocks.api(orgMembersContract.updateRole, ({ body, respond }) => {
    response = {
      ...response,
      members: response.members.map((member) => {
        return member.email === body.email
          ? { ...member, role: body.role }
          : member;
      }),
    };
    return respond(200, { message: "Role updated" });
  });
  context.mocks.api(orgMembersContract.removeMember, ({ body, respond }) => {
    response = {
      ...response,
      members: response.members.filter((member) => {
        return member.email !== body.email;
      }),
    };
    return respond(200, { message: "Member removed" });
  });
  context.mocks.api(
    orgMembershipRequestsContract.accept,
    ({ body, respond }) => {
      const request = response.membershipRequests?.find((candidate) => {
        return candidate.id === body.requestId;
      });
      response = {
        ...response,
        membershipRequests: response.membershipRequests?.filter((candidate) => {
          return candidate.id !== body.requestId;
        }),
        members: request
          ? [
              ...response.members,
              {
                userId: request.userId,
                email: request.email,
                firstName: request.firstName,
                lastName: request.lastName,
                imageUrl: request.imageUrl,
                role: "member",
                joinedAt: "2026-01-06T00:00:00Z",
              },
            ]
          : response.members,
      };
      return respond(200, { message: "Request accepted" });
    },
  );
  context.mocks.api(
    orgMembershipRequestsContract.reject,
    ({ body, respond }) => {
      response = {
        ...response,
        membershipRequests: response.membershipRequests?.filter((candidate) => {
          return candidate.id !== body.requestId;
        }),
      };
      return respond(200, { message: "Request rejected" });
    },
  );
  return {
    addPendingInvitation(invitation) {
      response = {
        ...response,
        pendingInvitations: [
          ...(response.pendingInvitations ?? []),
          invitation,
        ],
      };
    },
    membersRequestCount() {
      return membersRequestCount;
    },
  };
}

function mockMemberInviteEntitlement(
  required?: boolean,
  invitation?: {
    readonly tier: string;
    readonly allowed: boolean;
  },
  overrides: Partial<BillingStatusResponse> = {},
): void {
  const response: BillingStatusResponse = {
    tier: invitation?.tier ?? "pro",
    ...(required === undefined
      ? {}
      : { memberInviteUsagePackRequired: required }),
    ...(invitation === undefined
      ? {}
      : { memberInvitationAllowed: invitation.allowed }),
    credits: 0,
    onboardingPaymentPending: false,
    subscriptionStatus: "active",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: true,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 1,
    concurrencySubscriptions: [],
    ...overrides,
  };
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, response);
  });
}

function mockUsagePackManagement(onRequest?: () => void): void {
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    onRequest?.();
    return respond(200, {
      tier: "pro",
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      allocations: [
        {
          id: "a99c2cd1-b012-4ba5-952f-3aa9b707d0c6",
          memberId: "test-user-123",
          usagePackUsd: 20,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          pendingChange: null,
        },
        {
          id: "d0b55925-a0b3-4dd2-a433-f114bdf6cd2a",
          memberId: "user-bob",
          usagePackUsd: 50,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          pendingChange: null,
        },
        {
          id: "4875750e-c7a1-4740-bafb-3466443955f4",
          memberId: "user-eve",
          usagePackUsd: 100,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          pendingChange: null,
        },
      ],
    });
  });
}

function mockUsagePackCatalog(): void {
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          totalCredits: 20_400,
        },
        {
          usagePackUsd: 50,
          priceUsd: 50,
          purchasedCredits: 50_000,
          bonusCredits: 2600,
          totalCredits: 52_600,
        },
        {
          usagePackUsd: 100,
          priceUsd: 100,
          purchasedCredits: 100_000,
          bonusCredits: 8700,
          totalCredits: 108_700,
        },
        {
          usagePackUsd: 200,
          priceUsd: 200,
          purchasedCredits: 200_000,
          bonusCredits: 22_200,
          totalCredits: 222_200,
        },
      ],
    });
  });
}

async function openMembersTab(heading = "People"): Promise<void> {
  mockMemberInviteEntitlement(false);
  detachedSetupPage({
    context,
    path: "/?settings=people",
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  });
}

function rowByEmail(email: string): HTMLElement {
  const row = screen.getByText(email).closest(".grid");
  if (!row) {
    throw new Error(`${email} member row not found`);
  }
  return row as HTMLElement;
}

describe("organization members settings", () => {
  it("filters members and sends an invitation", async () => {
    mockMembersStory();
    await openMembersTab();

    expect(screen.getByText("Alice Admin")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    expect(screen.getByText("Carol Request")).toBeInTheDocument();

    await fill(screen.getByPlaceholderText("Search"), "bob");
    await waitFor(() => {
      expect(screen.getByText("bob@example.com")).toBeInTheDocument();
      expect(screen.queryByText("Alice Admin")).not.toBeInTheDocument();
    });

    click(buttonByText("Add member"));
    const inviteDialog = await screen.findByRole("dialog", {
      name: "Invite member",
    });
    await fill(
      within(inviteDialog).getByPlaceholderText("email@example.com"),
      "bob.invited@example.com",
    );
    click(buttonByText("Send invitation", inviteDialog));

    await waitFor(() => {
      expect(screen.getByText("bob.invited@example.com")).toBeInTheDocument();
    });
  });

  it("reviews and confirms a paid invitation without leaving the app", async () => {
    const membersStory = mockMembersStory();
    mockMemberInviteEntitlement(true);
    mockUsagePackManagement();
    mockUsagePackCatalog();
    let previewBody: unknown;
    let confirmedPurchaseId: string | null = null;
    context.mocks.api(
      orgInviteContract.previewPurchase,
      ({ body, respond }) => {
        previewBody = body;
        return respond(200, {
          purchaseId: "c08a5fab-a05d-43f9-a1ee-10feaf27584c",
          usagePackUsd: 50,
          immediateAmountCents: 2500,
          currency: "usd",
          purchasedCredits: 25_000,
          bonusCredits: 1300,
          totalCredits: 26_300,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          expiresAt: "2026-08-13T00:00:00.000Z",
        });
      },
    );
    context.mocks.api(
      orgInviteContract.confirmPurchase,
      ({ params, respond }) => {
        confirmedPurchaseId = params.purchaseId;
        return respond(200, {
          message: "Invitation purchased and sent",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=people",
    });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "People" }),
      ).toBeInTheDocument();
    });
    await expect(screen.findByText("Usage pack")).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });
    expect(
      within(rowByEmail("alice@example.com")).getByText("$20/month"),
    ).toBeInTheDocument();
    expect(
      within(rowByEmail("bob@example.com")).getByText("$50/month"),
    ).toBeInTheDocument();
    expect(
      within(rowByEmail("eve@example.com")).getByText("$100/month"),
    ).toBeInTheDocument();
    const initialHref = window.location.href;
    click(buttonByText("Add member"));
    const inviteDialog = await screen.findByRole("dialog", {
      name: "Invite member",
    });
    await fill(
      within(inviteDialog).getByPlaceholderText("email@example.com"),
      "paid.invitee@example.com",
    );
    await expect(
      within(inviteDialog).findByText("Member packages"),
    ).resolves.toBeInTheDocument();
    const packageSelector = within(inviteDialog).getAllByRole("combobox")[1];
    if (!packageSelector) {
      throw new Error("Usage pack selector not found");
    }
    click(packageSelector);
    click(
      await screen.findByRole("option", {
        name: "$50 · 52,600 credits · 5% off",
      }),
    );
    click(buttonByText("Continue", inviteDialog));

    const confirmationDialog = await screen.findByRole("dialog", {
      name: "Review invitation",
    });
    expect(within(confirmationDialog).getByText("$25.00")).toBeVisible();
    expect(
      within(confirmationDialog).getByText("paid.invitee@example.com"),
    ).toBeVisible();
    expect(within(confirmationDialog).getByText("Invite as")).toBeVisible();
    expect(
      within(confirmationDialog).getByText("Member · 26,300 credits"),
    ).toBeVisible();
    expect(within(confirmationDialog).getByText("Due today")).toBeVisible();
    expect(previewBody).toStrictEqual({
      email: "paid.invitee@example.com",
      role: "member",
      usagePackUsd: 50,
      supportsInAppPreview: true,
      returnUrl: new URL(
        window.location.pathname,
        window.location.origin,
      ).toString(),
    });
    expect(window.location.href).toBe(initialHref);
    const membersRequestsBeforeConfirm = membersStory.membersRequestCount();
    click(buttonByText("Pay and invite", confirmationDialog));

    await waitFor(() => {
      expect(confirmedPurchaseId).toBe("c08a5fab-a05d-43f9-a1ee-10feaf27584c");
      expect(membersStory.membersRequestCount()).toBeGreaterThan(
        membersRequestsBeforeConfirm,
      );
      expect(
        screen.queryByRole("dialog", { name: "Review invitation" }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText("paid.invitee@example.com"),
    ).not.toBeInTheDocument();

    membersStory.addPendingInvitation({
      id: "inv-paid",
      email: "paid.invitee@example.com",
      role: "member",
      createdAt: "2026-01-06T00:00:00Z",
      usagePackUsd: 50,
    });
    const membersRequestsBeforeBillingChange =
      membersStory.membersRequestCount();
    context.mocks.ably.trigger("billing:changed");

    await waitFor(() => {
      expect(membersStory.membersRequestCount()).toBeGreaterThan(
        membersRequestsBeforeBillingChange,
      );
    });
    await screen.findByText("paid.invitee@example.com");
    expect(
      within(rowByEmail("paid.invitee@example.com")).getByText("$50/month"),
    ).toBeInTheDocument();
    expect(window.location.href).toBe(initialHref);
  });

  it("shows a scheduled usage pack downgrade beside the current package", async () => {
    mockMembersStory();
    mockMemberInviteEntitlement(true);
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        allocations: [
          {
            id: "4875750e-c7a1-4740-bafb-3466443955f4",
            memberId: "user-eve",
            usagePackUsd: 100,
            currentPeriodEnd: "2026-09-01T00:00:00.000Z",
            pendingChange: {
              id: "8044563e-ef31-4fb6-aa31-e7ecb2b1a5f6",
              kind: "downgrade",
              status: "scheduled",
              targetUsagePackUsd: 50,
              effectiveAt: "2026-09-01T00:00:00.000Z",
            },
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: "/?settings=people",
    });

    await expect(screen.findByText("Usage pack")).resolves.toBeInTheDocument();
    const eveRow = rowByEmail("eve@example.com");
    expect(within(eveRow).getByText("$100/month")).toBeVisible();
    expect(
      within(eveRow).getByText("Downgrades to $50 on Sep 1, 2026."),
    ).toBeVisible();
    expect(
      within(rowByEmail("alice@example.com")).queryByText(/Downgrades to/u),
    ).not.toBeInTheDocument();
  });

  it("clears a failed invitation purchase before its dialog reopens", async () => {
    mockMembersStory();
    mockMemberInviteEntitlement(true);
    mockUsagePackManagement();
    mockUsagePackCatalog();
    let previewCount = 0;
    const purchaseError =
      "Your payment method changed. Review the invitation again.";
    context.mocks.api(
      orgInviteContract.previewPurchase,
      ({ body, respond }) => {
        previewCount += 1;
        return respond(200, {
          purchaseId:
            previewCount === 1
              ? "c08a5fab-a05d-43f9-a1ee-10feaf27584c"
              : "d19b6abc-b16e-54fa-b2ff-21afbf38695d",
          usagePackUsd: body.usagePackUsd,
          immediateAmountCents: 1000,
          currency: "usd",
          purchasedCredits: 10_000,
          bonusCredits: 200,
          totalCredits: 10_200,
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          expiresAt: "2026-08-13T00:00:00.000Z",
          paymentMethodPreviewToken: `invite-payment-token-${previewCount}`,
        });
      },
    );
    context.mocks.api(orgInviteContract.confirmPurchase, ({ respond }) => {
      return respond(409, {
        error: {
          code: "INVITATION_PURCHASE_PAYMENT_METHOD_CHANGED",
          message: purchaseError,
        },
      });
    });

    detachedSetupPage({
      context,
      path: "/?settings=people",
    });
    await expect(screen.findByText("Usage pack")).resolves.toBeInTheDocument();

    const openPurchase = async (email: string): Promise<HTMLElement> => {
      click(buttonByText("Add member"));
      const inviteDialog = await screen.findByRole("dialog", {
        name: "Invite member",
      });
      await fill(
        within(inviteDialog).getByPlaceholderText("email@example.com"),
        email,
      );
      await expect(
        within(inviteDialog).findByText("Member packages"),
      ).resolves.toBeInTheDocument();
      click(buttonByText("Continue", inviteDialog));
      return await screen.findByRole("dialog", {
        name: "Review invitation",
      });
    };

    const firstDialog = await openPurchase("first@example.com");
    click(buttonByText("Pay and invite", firstDialog));
    await expect(screen.findByText(purchaseError)).resolves.toBeInTheDocument();
    await within(firstDialog).findByText(
      "Could not purchase this member package. Review your billing details and try again.",
    );
    click(buttonByText("Cancel", firstDialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Review invitation" }),
      ).not.toBeInTheDocument();
    });

    const reopenedDialog = await openPurchase("second@example.com");
    expect(
      within(reopenedDialog).queryByText(
        "Could not purchase this member package. Review your billing details and try again.",
      ),
    ).not.toBeInTheDocument();
    expect(previewCount).toBe(2);
  });

  it("opens the current plan package configuration from member actions", async () => {
    mockMembersStory();
    mockMemberInviteEntitlement(true);
    mockUsagePackManagement();
    mockUsagePackCatalog();

    detachedSetupPage({
      context,
      path: "/?settings=people",
    });
    await expect(screen.findByText("Usage pack")).resolves.toBeInTheDocument();

    click(screen.getByLabelText("Actions for alice@example.com"));
    click(menuItemByText("Configure member packages"));

    await expect(
      screen.findByRole("heading", { name: "Billing" }),
    ).resolves.toBeInTheDocument();
    const memberUsage = await screen.findByRole("group", {
      name: "Member usage",
    });
    expect(
      within(memberUsage).getByRole("combobox", {
        name: "Usage for Test User",
      }),
    ).toHaveTextContent("20,400 credits · 2% off");
  });

  it("requires Atom-granted workspaces to configure member packages before inviting", async () => {
    mockMembersStory();
    mockMemberInviteEntitlement(true, undefined, {
      subscriptionStatus: "atom_grant",
      hasSubscription: false,
      cancelAtPeriodEnd: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: "2026-09-01T00:00:00.000Z",
      },
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          message: "Usage pack subscription not found",
          code: "NOT_FOUND",
        },
      });
    });
    mockUsagePackCatalog();

    detachedSetupPage({
      context,
      path: "/?settings=people",
    });
    await screen.findByRole("heading", { name: "People" });
    click(buttonByText("Add member"));

    const inviteDialog = await screen.findByRole("dialog", {
      name: "Invite member",
    });
    await expect(
      within(inviteDialog).findByText(
        "Every member needs a package. You pick each member's package in the next step.",
      ),
    ).resolves.toBeVisible();
    expect(
      within(inviteDialog).queryByPlaceholderText("email@example.com"),
    ).not.toBeInTheDocument();
    expect(
      within(inviteDialog).queryByText("Send invitation"),
    ).not.toBeInTheDocument();

    click(buttonByText("Cancel", inviteDialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Invite member" }),
      ).not.toBeInTheDocument();
    });
    click(buttonByText("Add member"));
    const reopenedInviteDialog = await screen.findByRole("dialog", {
      name: "Invite member",
    });
    expect(
      within(reopenedInviteDialog).queryByPlaceholderText("email@example.com"),
    ).not.toBeInTheDocument();
    expect(
      buttonByText("Configure member packages", reopenedInviteDialog),
    ).toBeEnabled();

    click(buttonByText("Configure member packages", reopenedInviteDialog));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    expect(buttonByText("Manage", proPlan)).toBeEnabled();
  });

  it.each([
    { entitlement: false, label: "false" },
    { entitlement: undefined, label: "absent" },
  ] as const)(
    "keeps invitations package-free when the org entitlement is $label",
    async ({ entitlement }) => {
      mockMembersStory();
      mockMemberInviteEntitlement(entitlement);
      let managementRequested = false;
      context.mocks.api(
        billingUsagePackManagementContract.get,
        ({ respond }) => {
          managementRequested = true;
          return respond(200, {
            tier: "pro",
            currentPeriodEnd: "2026-09-01T00:00:00.000Z",
            allocations: [],
          });
        },
      );

      detachedSetupPage({
        context,
        path: "/?settings=people",
      });
      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "People" }),
        ).toBeInTheDocument();
      });
      click(buttonByText("Add member"));
      const inviteDialog = await screen.findByRole("dialog", {
        name: "Invite member",
      });
      await fill(
        within(inviteDialog).getByPlaceholderText("email@example.com"),
        "legacy.invitee@example.com",
      );
      const send = buttonByText("Send invitation", inviteDialog);
      await waitFor(() => {
        expect(send).toBeEnabled();
      });
      expect(
        within(inviteDialog).queryByText("Member packages"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Usage pack")).not.toBeInTheDocument();
      expect(managementRequested).toBeFalsy();
      click(send);

      await waitFor(() => {
        expect(
          screen.getByText("legacy.invitee@example.com"),
        ).toBeInTheDocument();
      });
    },
  );

  it("opens compare plans when member invitations require Pro", async () => {
    mockMembersStory();
    mockMemberInviteEntitlement(false, {
      tier: "limited-free-1",
      allowed: false,
    });
    mockUsagePackCatalog();

    detachedSetupPage({
      context,
      path: "/?settings=people",
    });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "People" }),
      ).toBeInTheDocument();
    });
    click(buttonByText("Add member"));
    const inviteDialog = await screen.findByRole("dialog", {
      name: "Upgrade to invite members",
    });
    expect(
      within(inviteDialog).getByText(
        /Member invitations are available on the Pro plan/u,
      ),
    ).toBeVisible();
    expect(
      within(inviteDialog).queryByPlaceholderText("email@example.com"),
    ).not.toBeInTheDocument();
    expect(within(inviteDialog).queryByText("Role")).not.toBeInTheDocument();
    const upgrade = buttonByText("Upgrade to Pro", inviteDialog);
    expect(upgrade).toBeEnabled();
    click(upgrade);

    await expect(
      screen.findByRole("heading", { name: "Choose a plan" }),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByRole("article", { name: "Pro plan" }),
    ).resolves.toBeInTheDocument();
  });

  it("accepts and rejects membership requests", async () => {
    mockMembersStory();
    await openMembersTab();

    await fill(screen.getByPlaceholderText("Search"), "carol");
    await waitFor(() => {
      expect(screen.getByText("Carol Request")).toBeInTheDocument();
      expect(screen.getAllByText("Request")).toHaveLength(2);
    });

    click(screen.getAllByTitle("Accept request")[0]!);

    await waitFor(() => {
      expect(screen.getByText("Carol Request")).toBeInTheDocument();
      expect(screen.getByText("Dan Reject")).toBeInTheDocument();
      expect(screen.getAllByText("Request")).toHaveLength(1);
    });
    expect(screen.getByText("carol@example.com")).toBeInTheDocument();

    await fill(screen.getByPlaceholderText("Search"), "dan");
    await waitFor(() => {
      expect(screen.getByText("Dan Reject")).toBeInTheDocument();
      expect(screen.getByText("Request")).toBeInTheDocument();
    });

    click(screen.getByTitle("Reject request"));

    await waitFor(() => {
      expect(
        screen.getByText("Membership request rejected"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Dan Reject")).not.toBeInTheDocument();
      expect(screen.queryByText("dan@example.com")).not.toBeInTheDocument();
    });
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("Membership request rejected"),
      ).not.toBeInTheDocument();
    });
  });

  it("changes roles, removes a member, and lets an admin self-demote", async () => {
    mockMembersStory();
    await openMembersTab();

    click(screen.getByLabelText("Actions for bob@example.com"));
    click(menuItemByText("Make admin"));

    await waitFor(() => {
      expect(
        screen.getByText("Updated role for bob@example.com"),
      ).toBeInTheDocument();
      expect(
        within(rowByEmail("bob@example.com")).getByText("Admin"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for bob@example.com"));
    click(menuItemByText("Remove from workspace"));

    const removeDialog = await screen.findByRole("dialog", {
      name: "Remove member?",
    });
    expect(
      within(removeDialog).getByText(/lose access to all resources/u),
    ).toBeInTheDocument();
    expect(
      within(removeDialog).queryByText("Usage pack impact"),
    ).not.toBeInTheDocument();
    click(buttonByText("Remove", removeDialog));

    await waitFor(() => {
      expect(screen.getByText("Removed bob@example.com")).toBeInTheDocument();
      expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for alice@example.com"));
    click(menuItemByText("Switch to member"));

    const selfDemoteDialog = await screen.findByRole("dialog", {
      name: "Switch to member?",
    });
    expect(
      within(selfDemoteDialog).getByText(/lose admin privileges/u),
    ).toBeInTheDocument();
    click(buttonByText("Confirm", selfDemoteDialog));

    await waitFor(() => {
      expect(
        screen.getByText("Updated role for alice@example.com"),
      ).toBeInTheDocument();
      expect(
        within(rowByEmail("alice@example.com")).getByText("Member"),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Actions for alice@example.com"),
      ).not.toBeInTheDocument();
    });
  });

  it("explains usage pack and refund consequences before removing a member", async () => {
    mockMembersStory();
    mockMemberInviteEntitlement(true);
    let managementRequests = 0;
    mockUsagePackManagement(() => {
      managementRequests += 1;
    });

    detachedSetupPage({
      context,
      path: "/?settings=people",
    });
    await expect(screen.findByText("Usage pack")).resolves.toBeInTheDocument();

    click(screen.getByLabelText("Actions for bob@example.com"));
    click(menuItemByText("Remove from workspace"));

    const removeDialog = await screen.findByRole("dialog", {
      name: "Remove member?",
    });
    expect(
      within(removeDialog).getByText("Usage pack impact"),
    ).toBeInTheDocument();
    expect(
      within(removeDialog).getByText(/credits become unavailable immediately/u),
    ).toBeInTheDocument();
    expect(
      within(removeDialog).getByText(
        /unused purchased-credit portion is returned/u,
      ),
    ).toBeInTheDocument();
    expect(
      within(removeDialog).getByText(
        /used credits and bonus credits are not refundable/iu,
      ),
    ).toBeInTheDocument();
    click(buttonByText("Remove", removeDialog));

    await waitFor(() => {
      expect(screen.getByText("Removed bob@example.com")).toBeInTheDocument();
      expect(managementRequests).toBeGreaterThan(1);
    });
  });

  it("cancels and confirms invitation revoke", async () => {
    mockMembersStory();
    await openMembersTab();

    await fill(screen.getByPlaceholderText("Search"), "pending");
    await waitFor(() => {
      expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for pending@example.com"));
    click(menuItemByText("Revoke invitation"));

    const cancelRevokeDialog = await screen.findByRole("dialog", {
      name: "Revoke invitation?",
    });
    expect(
      within(cancelRevokeDialog).getByText(
        /will no longer be able to join using this invitation/i,
      ),
    ).toBeInTheDocument();
    click(buttonByText("Cancel", cancelRevokeDialog));

    await waitFor(() => {
      expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Actions for pending@example.com"));
    click(menuItemByText("Revoke invitation"));

    const revokeDialog = await screen.findByRole("dialog", {
      name: "Revoke invitation?",
    });
    click(buttonByText("Revoke", revokeDialog));

    await waitFor(() => {
      expect(screen.getByText("Invitation revoked")).toBeInTheDocument();
      expect(screen.queryByText("pending@example.com")).not.toBeInTheDocument();
    });
  });

  it("localizes the invitation flow without translating workspace data", async () => {
    mockMembersStory();
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });
    await openMembersTab("Pessoas");

    const settingsDialog = screen.getByRole("dialog", {
      name: "Configurações",
    });
    expect(
      within(settingsDialog).getByText("Espaço de trabalho"),
    ).toBeVisible();
    expect(buttonByLabel("Fechar", settingsDialog)).toBeVisible();
    expect(screen.getByText("alice@example.com")).toBeVisible();
    expect(screen.getByText("01/01/2026")).toBeVisible();

    await fill(screen.getByPlaceholderText("Pesquisar"), "bob");
    click(buttonByText("Adicionar membro"));

    const inviteDialog = await screen.findByRole("dialog", {
      name: "Convidar membro",
    });
    expect(buttonByLabel("Fechar", inviteDialog)).toBeVisible();
    await fill(
      within(inviteDialog).getByPlaceholderText("email@example.com"),
      "bob.invited@example.com",
    );
    click(buttonByText("Enviar convite", inviteDialog));

    await waitFor(() => {
      expect(screen.getByText("bob.invited@example.com")).toBeInTheDocument();
      expect(
        screen.getByText("Convite enviado para bob.invited@example.com"),
      ).toBeInTheDocument();
    });
  });
});
