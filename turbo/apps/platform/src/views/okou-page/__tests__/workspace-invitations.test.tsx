import { fireEvent, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockedClerk,
  mockSignInResource,
  type MockedMembership,
} from "../../../__tests__/mock-auth.ts";
import { search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function currentWorkspaceMembership(): MockedMembership {
  return {
    id: "membership_current",
    organization: {
      id: "org_current",
      name: "Current Workspace",
    },
  };
}

function invitationTicket(organizationId: string): string {
  const encodedPayload = btoa(
    JSON.stringify({ oid: organizationId, st: "organization_invitation" }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `header.${encodedPayload}.signature`;
}

function actionByName(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const action = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!action) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return action;
}

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected form control to be inside a form");
  }
  return form;
}

function completedInvitationPath(ticket: string): string {
  const params = new URLSearchParams([
    ["utm_campaign", "workspace-invite"],
    ["utm_content", "email"],
    ["utm_content", "reminder"],
    ["__clerk_status", "complete"],
    ["__clerk_ticket", ticket],
  ]);
  return `/agents?${params.toString()}#private-agents`;
}

test("An invitation accepted for another account offers account switching", async () => {
  await setupPage({
    context,
    path: completedInvitationPath(invitationTicket("org_invited")),
    auth: {
      user: {
        id: "user_current",
        fullName: "Current Account",
        email: "current@example.com",
      },
      organization: {
        activeOrg: {
          id: "org_current",
          name: "Current Workspace",
        },
        memberships: [currentWorkspaceMembership()],
      },
    },
  });

  const acceptedNotice = await screen.findByText(
    "Invitation accepted for another account",
  );
  expect(acceptedNotice).toBeVisible();
  expect(location.hash).toBe("#private-agents");

  click(actionByName("button", "Switch account"));

  const dialog = await screen.findByRole("dialog", {
    name: "Sign in to Okou",
  });
  const emailAddress = within(dialog).getByLabelText("Email address");
  expect(emailAddress).toBeVisible();
  expect(emailAddress).toHaveValue("");
});

test("An invitation requiring a password continues without exposing the ticket", async () => {
  const ticket = invitationTicket("org_invited");
  const params = new URLSearchParams([
    ["utm_campaign", "workspace-invite"],
    ["__clerk_status", "sign_in"],
    ["__clerk_ticket", ticket],
  ]);
  mockSignInResource({ status: "needs_identifier" });
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    mockSignInResource({
      status: "needs_first_factor",
      identifier: "invitee@example.com",
      supportedFirstFactors: [{ strategy: "password" }],
    });
    return Promise.resolve(mockedClerk.client.signIn);
  });
  await setupPage({
    context,
    path: `/sign-in?${params.toString()}`,
    host: "app.okou.ai",
    auth: null,
  });

  await screen.findByRole("heading", { name: "Use another method" });
  click(actionByName("button", "Sign in with your password"));
  const password = await screen.findByLabelText("Password");
  expect(password).toBeVisible();
  const remainingParams = new URLSearchParams(search());
  expect(remainingParams.get("__clerk_status")).toBeNull();
  expect(remainingParams.get("__clerk_ticket")).toBeNull();
  expect(mockedClerk.clientSignInCreate).toHaveBeenCalledExactlyOnceWith({
    strategy: "ticket",
    ticket,
  });
  expect(remainingParams.get("utm_campaign")).toBe("workspace-invite");
  expect(
    screen.queryByText(/^Invitation accepted(?: for)?/u),
  ).not.toBeInTheDocument();
  mockedClerk.signInAttemptFirstFactor.mockImplementation(() => {
    mockSignInResource({
      status: "complete",
      createdSessionId: "session_invited",
    });
    return Promise.resolve(mockedClerk.client.signIn);
  });
  await fill(password, "A good password 123!");
  fireEvent.submit(containingForm(password));
  await screen.findByRole("heading", { name: "Sign-in complete" });
  expect(mockedClerk.setActive).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ session: "session_invited" }),
  );
});
