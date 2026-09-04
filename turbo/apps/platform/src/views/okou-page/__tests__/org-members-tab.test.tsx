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
import { expect, test } from "vitest";

import {
  click,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

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

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function mockMembersStory(
  onInvite?: (invite: {
    readonly email: string;
    readonly role: string;
  }) => void,
): {
  readonly addPendingInvitation: (
    invitation: NonNullable<OrgMembersResponse["pendingInvitations"]>[number],
  ) => void;
} {
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
    return respond(200, response);
  });
  context.mocks.api(orgInviteContract.invite, ({ body, respond }) => {
    onInvite?.(body);
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

async function openMembersTab(): Promise<void> {
  mockMemberInviteEntitlement(false);
  await setupPage({
    context,
    path: "/?settings=people",
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
  });
}

function rowByEmail(email: string): HTMLElement {
  const row = screen.getByText(email).closest(".grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${email} member row not found`);
  }
  return row;
}

test("Show a scheduled package change on a pending invitation", async () => {
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

  await setupPage({
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

test("Clear a paid-invitation error before reopening Add member", async () => {
  mockMembersStory();
  mockMemberInviteEntitlement(true);
  mockUsagePackManagement();
  mockUsagePackCatalog();
  let previewCount = 0;
  const purchaseError =
    "Your payment method changed. Review the invitation again.";
  context.mocks.api(orgInviteContract.previewPurchase, ({ body, respond }) => {
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
  });
  context.mocks.api(orgInviteContract.confirmPurchase, ({ respond }) => {
    return respond(409, {
      error: {
        code: "INVITATION_PURCHASE_PAYMENT_METHOD_CHANGED",
        message: purchaseError,
      },
    });
  });

  await setupPage({
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
  expect(screen.queryByText("first@example.com")).not.toBeInTheDocument();

  click(buttonByText("Add member"));
  const reopenedDialog = await screen.findByRole("dialog", {
    name: "Invite member",
  });
  expect(
    within(reopenedDialog).getByPlaceholderText("email@example.com"),
  ).toHaveValue("");
  expect(
    within(reopenedDialog).queryByText(
      "Could not purchase this member package. Review your billing details and try again.",
    ),
  ).not.toBeInTheDocument();
  expect(within(reopenedDialog).queryByText(purchaseError)).toBeNull();
});

test("Configure a member’s package from People", async () => {
  mockMembersStory();
  mockMemberInviteEntitlement(true);
  mockUsagePackManagement();
  mockUsagePackCatalog();

  await setupPage({
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

test("Invite a member without a package when packages are not required", async () => {
  const entitlement = false;
  mockMembersStory();
  mockMemberInviteEntitlement(entitlement);

  await setupPage({
    context,
    path: "/?settings=people",
  });
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
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
  click(send);

  await waitFor(() => {
    expect(screen.getByText("legacy.invitee@example.com")).toBeInTheDocument();
  });
});

test("Choose a plan before inviting a member who needs a package", async () => {
  mockMembersStory();
  mockMemberInviteEntitlement(false, {
    tier: "limited-free-1",
    allowed: false,
  });
  mockUsagePackCatalog();

  await setupPage({
    context,
    path: "/?settings=people",
  });
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
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

test("Accept and reject workspace membership requests", async () => {
  mockMembersStory();
  await openMembersTab();

  expect(screen.getByText("Carol Request")).toBeInTheDocument();
  expect(screen.getByText("Dan Reject")).toBeInTheDocument();
  expect(screen.getAllByTitle("Accept request")).toHaveLength(2);

  click(screen.getAllByTitle("Accept request")[0]!);

  await waitFor(() => {
    expect(
      within(rowByEmail("carol@example.com")).getByText("Member"),
    ).toBeInTheDocument();
    expect(screen.getAllByTitle("Accept request")).toHaveLength(1);
  });
  expect(screen.getByText("Dan Reject")).toBeInTheDocument();

  click(screen.getByTitle("Reject request"));

  await waitFor(() => {
    expect(screen.getByText("Membership request rejected")).toBeInTheDocument();
    expect(screen.queryByText("Dan Reject")).not.toBeInTheDocument();
    expect(screen.queryByText("dan@example.com")).not.toBeInTheDocument();
  });
});

test("Promote a workspace member to administrator", async () => {
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
  expect(menuItemByText("Make member")).toBeInTheDocument();
});

test("Remove another member from the workspace", async () => {
  mockMembersStory();
  await openMembersTab();

  click(screen.getByLabelText("Actions for bob@example.com"));
  click(menuItemByText("Remove from workspace"));

  const removeDialog = await screen.findByRole("dialog", {
    name: "Remove member?",
  });
  expect(
    within(removeDialog).getByText(/lose access to all resources/u),
  ).toBeInTheDocument();
  expect(
    within(removeDialog).getByText(/bob@example\.com/u),
  ).toBeInTheDocument();
  expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  click(buttonByText("Remove", removeDialog));

  await waitFor(() => {
    expect(screen.getByText("Removed bob@example.com")).toBeInTheDocument();
    expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument();
  });
});

test("Demote yourself from workspace administrator", async () => {
  mockMembersStory();
  await openMembersTab();

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

test("Explain package and credit effects before removing a member", async () => {
  mockMembersStory();
  mockMemberInviteEntitlement(true);
  mockUsagePackManagement();

  await setupPage({
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
      /package is removed at the end of the current billing period/u,
    ),
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
  expect(screen.getByText("bob@example.com")).toBeInTheDocument();
});

test("Revoke a pending workspace invitation", async () => {
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
