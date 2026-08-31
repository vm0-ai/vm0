import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { PostHog } from "posthog-js/dist/module.slim";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../../__tests__/page-helper.ts";
import {
  mockAuthV2Capabilities,
  mockedClerk,
  mockSignInResource,
} from "../../../../__tests__/mock-auth.ts";
import { AUTH_V2_DIAGNOSTIC_EVENT } from "../../../../lib/posthog.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";

const { apiOriginMarker, posthog } = vi.hoisted(() => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_auth_v2_recovery_diagnostics_test");
  window.location.href = "https://app.vm0.ai/";
  const apiOriginMarker = document.createElement("meta");
  apiOriginMarker.name = "vm0-api-origin";
  apiOriginMarker.content = "https://api.vm0.ai";
  document.head.append(apiOriginMarker);
  return {
    apiOriginMarker,
    posthog: {
      capture: vi.fn<PostHog["capture"]>(),
      identify: vi.fn<PostHog["identify"]>(),
      init: vi.fn<PostHog["init"]>(),
      register: vi.fn<PostHog["register"]>(),
      reset: vi.fn<PostHog["reset"]>(),
      unregister: vi.fn<PostHog["unregister"]>(),
    },
  };
});

vi.mock("posthog-js/dist/module.slim", () => {
  return { posthog };
});

const context = testContext();

beforeEach(() => {
  posthog.capture.mockClear();
  posthog.identify.mockClear();
  posthog.init.mockClear();
  posthog.register.mockClear();
  posthog.reset.mockClear();
  posthog.unregister.mockClear();
});

afterAll(() => {
  apiOriginMarker.remove();
});

function diagnosticCalls(): unknown[][] {
  return posthog.capture.mock.calls.filter(([eventName]) => {
    return eventName === AUTH_V2_DIAGNOSTIC_EVENT;
  });
}

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected element to be inside a form");
  }
  return form;
}

function roleElement(role: "button", name: string) {
  return queryAllByRoleFast(role).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

async function waitForRoleElement(
  role: "button",
  name: string,
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(roleElement(role, name)).toBeDefined();
  });
  const element = roleElement(role, name);
  if (!element) {
    throw new Error(`Expected ${role} named ${name}`);
  }
  return element;
}

describe("auth v2 password recovery diagnostics", () => {
  it.each([
    {
      action: "Reset your password",
      method: "password-reset",
      operation: "prepare",
    },
    {
      action: "Continue with Apple",
      method: "apple-oauth",
      operation: "oauth",
    },
    {
      action: "Email code to p***@example.com",
      method: "email-code",
      operation: "prepare",
    },
    {
      action: "Sign in with your passkey",
      method: "passkey",
      operation: "passkey",
    },
  ] as const)(
    "attributes the $method recovery action through the rendered page",
    async ({ action, method, operation }) => {
      const privateIdentifier = "private.recovery@example.com";
      const privateProviderCode = `private_${method}_provider_code`;
      const privateProviderMessage = `Private ${method} provider detail`;
      const providerFailure = {
        errors: [
          {
            code: privateProviderCode,
            longMessage: privateProviderMessage,
          },
        ],
      };
      const supportedFirstFactors = [
        { strategy: "password" },
        {
          emailAddressId: "email_private",
          safeIdentifier: "p***@example.com",
          strategy: "reset_password_email_code",
        },
        { strategy: "oauth_apple" },
        {
          emailAddressId: "email_private",
          safeIdentifier: "p***@example.com",
          strategy: "email_code",
        },
        { strategy: "passkey" },
      ] as const;
      context.mocks.browser.webAuthn({ platformAuthenticatorResult: true });
      mockAuthV2Capabilities({ appleOAuth: true, passkey: true });
      if (operation === "prepare") {
        mockedClerk.signInPrepareFirstFactor.mockRejectedValueOnce(
          providerFailure,
        );
      } else if (operation === "oauth") {
        mockedClerk.signInAuthenticateWithRedirect.mockRejectedValueOnce(
          providerFailure,
        );
      } else {
        mockedClerk.signInAuthenticateWithPasskey.mockRejectedValueOnce(
          providerFailure,
        );
      }

      const path = "/v2/sign-in";
      context.mocks.browser.url(`https://app.vm0.ai${path}`);
      mockSignInResource({ status: "needs_identifier" });
      detachedSetupPage({
        context,
        path,
        session: null,
        user: null,
      });

      const identifierInput = await screen.findByLabelText("Email address");
      mockSignInResource({
        status: "needs_first_factor",
        supportedFirstFactors,
      });
      mockedClerk.clientSignInCreate.mockResolvedValue(
        mockedClerk.client.signIn,
      );
      fireEvent.change(identifierInput, {
        target: { value: privateIdentifier },
      });
      fireEvent.submit(containingForm(identifierInput));
      await waitFor(() => {
        expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
          identifier: privateIdentifier,
        });
      });

      fireEvent.click(await waitForRoleElement("button", "Forgot password?"));
      await expect(
        screen.findByRole("heading", { name: "Forgot Password?" }),
      ).resolves.toBeVisible();
      fireEvent.click(await waitForRoleElement("button", action));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "This action couldn't be completed. Please try again later or contact support if this persists.",
      );
      expect(alert).not.toHaveTextContent(privateProviderMessage);
      await waitFor(() => {
        expect(document.activeElement).toBe(alert);
      });
      await waitFor(() => {
        expect(diagnosticCalls()).toStrictEqual([
          [
            AUTH_V2_DIAGNOSTIC_EVENT,
            {
              error_category: "none",
              flow: "sign-in",
              method: "identifier",
              outcome: "success",
              step: "identifier",
            },
          ],
          [
            AUTH_V2_DIAGNOSTIC_EVENT,
            {
              error_category: "provider-error",
              flow: "sign-in",
              method,
              outcome: "failure",
              step: "recovery",
            },
          ],
        ]);
      });
      const serializedCalls = JSON.stringify(diagnosticCalls());
      for (const prohibitedValue of [
        privateIdentifier,
        privateProviderCode,
        privateProviderMessage,
        "email_private",
      ]) {
        expect(serializedCalls).not.toContain(prohibitedValue);
      }
    },
  );
});
