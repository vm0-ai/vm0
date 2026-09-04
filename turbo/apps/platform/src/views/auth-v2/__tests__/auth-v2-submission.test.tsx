import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  mockAuthV2Capabilities,
  mockClerkSessionSignedOut,
  mockedClerk,
  mockSignInResource,
  mockSignUpResource,
  mockUser,
  type MockedSignInResourceState,
  type MockedSignUpResourceState,
} from "../../../__tests__/mock-auth.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const NOW = Date.parse("2026-08-25T08:00:00.000Z");
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function backgroundRecoveryAgent() {
  return {
    agentId: AGENT_ID,
    avatarUrl: null,
    description: "Reviews pending work",
    displayName: "Recovery Agent",
    modelProviderId: null,
    ownerId: "test-user-123",
    preferPersonalProvider: false,
    selectedModel: null,
    sound: null,
    visibility: "private" as const,
  };
}

function currentSignInResource() {
  return mockedClerk.client.signIn;
}

function moveSignInTo(state: MockedSignInResourceState) {
  mockSignInResource(state);
  return currentSignInResource();
}

function currentSignUpResource() {
  return mockedClerk.client.signUp;
}

function moveSignUpTo(state: MockedSignUpResourceState) {
  mockSignUpResource(state);
  return currentSignUpResource();
}

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected element to be inside a form");
  }
  return form;
}

function roleElement(
  role: "button" | "link" | "tab",
  name: string,
): HTMLElement | undefined {
  return queryAllByRoleFast(role).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

function waitForRoleElement(
  role: "button" | "link" | "tab",
  name: string,
): Promise<HTMLElement> {
  return waitFor(() => {
    const element = roleElement(role, name);
    if (!element) {
      throw new Error(`Expected ${role} named ${name}`);
    }
    return element;
  });
}

async function openAccountMenu(): Promise<HTMLElement> {
  const accountButton = await waitFor(() => {
    const rail = screen.queryByTestId("labeled-nav-rail");
    if (rail) {
      return within(rail).getByLabelText("Alex Rivera");
    }
    const minimalSidebar = document.querySelector(
      "aside.zero-nav:not(.zero-nav-rail)",
    );
    if (!(minimalSidebar instanceof HTMLElement)) {
      throw new Error("Account menu container not found");
    }
    const accountName = within(minimalSidebar).getByText("Alex Rivera");
    const button = accountName.closest("button");
    if (!button) {
      throw new Error("Account menu trigger not found");
    }
    return button;
  });
  click(accountButton);
  return screen.findByRole("menu");
}

async function openPasswordStep(): Promise<HTMLElement> {
  const identification =
    context.mocks.deferred<ReturnType<typeof currentSignInResource>>();
  mockSignInResource({ status: "needs_identifier" });
  mockedClerk.clientSignInCreate.mockReturnValueOnce(identification.promise);
  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-in",
    auth: null,
  });
  const identifier = await screen.findByLabelText("Email address");
  await fill(identifier, "person@example.com");
  fireEvent.submit(containingForm(identifier));
  identification.resolve(
    moveSignInTo({
      identifier: "person@example.com",
      status: "needs_first_factor",
      supportedFirstFactors: [{ strategy: "password" }],
    }),
  );
  return screen.findByLabelText("Password");
}

test("Repeated sign-in clicks create one pending attempt", async () => {
  const attempt = createDeferredPromise<
    ReturnType<typeof currentSignInResource>
  >(context.signal);
  const retry =
    context.mocks.deferred<ReturnType<typeof currentSignInResource>>();
  mockedClerk.signInAttemptFirstFactor
    .mockImplementationOnce(() => {
      return attempt.promise;
    })
    .mockReturnValueOnce(retry.promise);
  const password = await openPasswordStep();
  await fill(password, "first-password");
  const form = containingForm(password);

  fireEvent.submit(form);
  fireEvent.submit(form);

  await waitFor(() => {
    expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledTimes(1);
  });
  await expect(
    waitForRoleElement("button", "Continue"),
  ).resolves.toHaveAttribute("aria-busy", "true");

  await act(async () => {
    attempt.resolve(
      moveSignInTo({
        identifier: "person@example.com",
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "password" }],
      }),
    );
    await attempt.promise;
  });
  const currentPassword = await screen.findByLabelText("Password");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await fill(currentPassword, "correct-password");
  fireEvent.submit(containingForm(currentPassword));
  retry.resolve(
    moveSignInTo({
      createdSessionId: "session_retry",
      status: "complete",
    }),
  );

  await waitFor(() => {
    expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledTimes(2);
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });
});

test("Sign-in can complete while background page recovery is pending", async () => {
  const user = userEvent.setup({ delay: null });
  const backgroundCanFinish = context.mocks.deferred<void>();
  const identification =
    context.mocks.deferred<ReturnType<typeof currentSignInResource>>();
  let backgroundRequests = 0;
  let backgroundFinished = false;
  context.mocks.http.get("*/api/agents/:id/user-connectors", async () => {
    backgroundRequests += 1;
    await backgroundCanFinish.promise;
    backgroundFinished = true;
    return HttpResponse.json({ enabledConnectorSlugs: [] });
  });
  context.mocks.data.agents([backgroundRecoveryAgent()]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, backgroundRecoveryAgent());
  });
  mockSignInResource({ status: "needs_identifier" });
  mockedClerk.clientSignInCreate.mockReturnValueOnce(identification.promise);
  mockedClerk.signOut.mockImplementation(() => {
    mockUser(null, null);
    mockClerkSessionSignedOut(true);
    window.history.pushState(null, "", "/sign-in");
    window.dispatchEvent(new PopStateEvent("popstate"));
    return Promise.resolve();
  });
  await setupPage({
    context,
    host: "app.vm0.ai",
    path: `/agents/${AGENT_ID}?tab=profile`,
    auth: {
      user: {
        email: "alex.rivera@example.test",
        fullName: "Alex Rivera",
        id: "test-user-123",
      },
    },
  });
  await expect(
    screen.findByRole("heading", { name: "Recovery Agent" }),
  ).resolves.toBeInTheDocument();

  await user.click(await waitForRoleElement("tab", "Authorization"));
  await waitFor(() => {
    expect(backgroundRequests).toBe(1);
  });
  const accountMenu = await openAccountMenu();
  await user.click(within(accountMenu).getByText("Sign out"));

  const identifier = await screen.findByLabelText("Email address");
  expect(backgroundFinished).toBeFalsy();

  await fill(identifier, "person@example.com");
  fireEvent.submit(containingForm(identifier));
  identification.resolve(
    moveSignInTo({
      createdSessionId: "session_completed_during_recovery",
      status: "complete",
    }),
  );

  await waitFor(() => {
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      session: "session_completed_during_recovery",
    });
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledTimes(1);
  });
  expect(backgroundRequests).toBe(1);
  expect(backgroundFinished).toBeFalsy();

  await act(async () => {
    backgroundCanFinish.resolve();
    await backgroundCanFinish.promise;
  });
});

test("Switching methods does not duplicate a pending sign-up", async () => {
  mockNow(NOW, context.signal);
  mockAuthV2Capabilities({ googleOAuth: true });
  mockSignUpResource({ status: null });
  const creation = createDeferredPromise<
    ReturnType<typeof currentSignUpResource>
  >(context.signal);
  mockedClerk.clientSignUpCreate.mockImplementation(() => {
    return creation.promise;
  });
  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-up",
    auth: null,
  });
  const email = await screen.findByLabelText("Email address");
  const password = screen.getByLabelText("Password");
  await fill(email, "person@example.com");
  await fill(password, "valid-password");
  const google = await waitForRoleElement("button", "Continue with Google");
  const form = containingForm(email);

  fireEvent.submit(form);
  fireEvent.submit(form);
  click(google);

  await waitFor(() => {
    expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledTimes(1);
  });
  expect(mockedClerk.signUpAuthenticateWithRedirect).not.toHaveBeenCalled();
  expect(google).toBeDisabled();

  await act(async () => {
    creation.resolve(
      moveSignUpTo({
        emailAddress: "person@example.com",
        emailVerificationExpireAt: new Date(NOW + 10 * 60 * 1000),
        emailVerificationStatus: "unverified",
        emailVerificationStrategy: "email_code",
        hasPassword: true,
        missingFields: [],
        status: "missing_requirements",
        unverifiedFields: ["email_address"],
      }),
    );
    await creation.promise;
  });
  const verification = await screen.findByRole("region", {
    name: "Verify your email",
  });
  const editEmail = queryAllByRoleFast("button", verification).find(
    (candidate) => {
      return (
        candidate.textContent?.trim() === "Edit email address" ||
        candidate.getAttribute("aria-label") === "Edit email address"
      );
    },
  );
  if (!editEmail) {
    throw new Error("Edit email address button not found");
  }
  click(editEmail);
  const availableGoogle = await waitForRoleElement(
    "button",
    "Continue with Google",
  );

  click(availableGoogle);

  await waitFor(() => {
    expect(mockedClerk.signUpAuthenticateWithRedirect).toHaveBeenCalledTimes(1);
  });
  expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledTimes(1);
});
