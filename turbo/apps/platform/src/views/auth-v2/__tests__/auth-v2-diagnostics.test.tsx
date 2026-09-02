import { fireEvent, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  mockedClerk,
  mockSignInResource,
} from "../../../__tests__/mock-auth.ts";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { AUTH_V2_DIAGNOSTIC_EVENT } from "../../../lib/posthog.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

vi.hoisted(() => {
  const posthogKey = "phc_auth_v2_diagnostics_test";
  vi.stubEnv("VITE_POSTHOG_KEY", posthogKey);
  return { posthogKey };
});

const context = testContext();

function diagnosticCalls(): unknown[][] {
  return context.mocks
    .posthog()
    .events.filter(({ name }) => {
      return name === AUTH_V2_DIAGNOSTIC_EVENT;
    })
    .map(({ name, properties }) => {
      return [name, properties];
    });
}

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected element to be inside a form");
  }
  return form;
}

function setupSignIn(path = "/sign-in"): Promise<void> {
  context.mocks.posthog();
  return setupPage({ context, host: "app.vm0.ai", path, auth: null });
}

test("Provider errors do not leak account identifiers", async () => {
  const privateIdentifier = "private.person@example.com";
  const privateCode = "provider_private_4d0ad5";
  mockSignInResource({ status: "needs_identifier" });
  mockedClerk.clientSignInCreate.mockRejectedValue({
    errors: [
      {
        code: privateCode,
        identifier: privateIdentifier,
        longMessage: "Private account state",
      },
    ],
  });
  await setupSignIn();
  const identifier = await screen.findByLabelText("Email address");
  await fill(identifier, privateIdentifier);

  fireEvent.submit(containingForm(identifier));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "This action couldn't be completed. Please try again later or contact support if this persists.",
  );
  const serialized = JSON.stringify(diagnosticCalls());
  expect(serialized).not.toContain(privateIdentifier);
  expect(serialized).not.toContain(privateCode);
  expect(serialized).not.toContain("Private account state");
});
