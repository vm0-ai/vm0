import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mockedClerk,
  mockSignInResource,
  mockSignUpResource,
} from "../__tests__/mock-auth.ts";
import { setupPage } from "../__tests__/page-helper.ts";
import { AUTH_V2_DIAGNOSTIC_EVENT, initPostHog } from "../lib/posthog.ts";
import { testContext } from "./__tests__/test-helpers.ts";

interface CapturedPostHogEvent {
  readonly event: string;
  readonly properties: Record<string, unknown>;
  readonly timestamp?: string;
  readonly uuid: string;
  readonly [property: string]: unknown;
}

type BeforeSend = (
  event: CapturedPostHogEvent | null,
) => CapturedPostHogEvent | null;
type Capture = (
  eventName: string,
  properties?: Record<string, unknown>,
) => void;
type Identify = (
  distinctId: string,
  properties?: Record<string, unknown>,
) => void;
type Init = (
  key: string,
  config?: { readonly before_send?: BeforeSend },
) => void;
type Register = (properties: Record<string, unknown>) => void;
type Reset = () => void;
type Unregister = (property: string) => void;

const { apiOriginMarker, posthog, posthogKey } = vi.hoisted(() => {
  const posthogKey = "phc_auth_v2_diagnostics_test";
  vi.stubEnv("VITE_POSTHOG_KEY", posthogKey);
  window.location.href = "https://app.vm0.ai/";
  const apiOriginMarker = document.createElement("meta");
  apiOriginMarker.name = "vm0-api-origin";
  apiOriginMarker.content = "https://api.vm0.ai";
  document.head.append(apiOriginMarker);
  return {
    apiOriginMarker,
    posthogKey,
    posthog: {
      capture: vi.fn<Capture>(),
      identify: vi.fn<Identify>(),
      init: vi.fn<Init>(),
      register: vi.fn<Register>(),
      reset: vi.fn<Reset>(),
      unregister: vi.fn<Unregister>(),
    },
  };
});

vi.mock("posthog-js/dist/module.slim", () => {
  return { posthog };
});

const context = testContext();

afterAll(() => {
  apiOriginMarker.remove();
});

beforeEach(() => {
  posthog.capture.mockClear();
  posthog.identify.mockClear();
  posthog.init.mockClear();
  posthog.register.mockClear();
  posthog.reset.mockClear();
  posthog.unregister.mockClear();
});

function diagnosticCalls(): unknown[][] {
  return posthog.capture.mock.calls.filter(([eventName]) => {
    return eventName === AUTH_V2_DIAGNOSTIC_EVENT;
  });
}

async function setupUnknownContinuation(path: string): Promise<void> {
  context.mocks.browser.url(`https://app.vm0.ai${path}`);
  await setupPage({
    context,
    org: { activeOrg: null, memberships: [] },
    path,
    session: { token: "session_token_private_49bd" },
    user: {
      clientSessions: [
        {
          currentTask: { key: "private-provider-task-71f0" },
          id: "session_private_7ed3",
          status: "pending",
          user: {
            fullName: "Private Person",
            organizationMemberships: [],
          },
        },
      ],
      email: "private.person@example.com",
      fullName: "Private Person",
      id: "user_private_b21c",
    },
    withoutRender: true,
  });
}

describe("auth v2 route diagnostics", () => {
  it.each(["/sign-in", "/sign-up"])(
    "does not emit auth v2 diagnostics from the v1 route %s",
    async (path) => {
      context.mocks.browser.url(`https://app.vm0.ai${path}`);

      await setupPage({ context, path, withoutRender: true });

      expect(diagnosticCalls()).toStrictEqual([]);
    },
  );

  it.each([
    ["sign-in", "/v2/sign-in/tasks/ticket_private_15c9"],
    ["sign-up", "/v2/sign-up/tasks/ticket_private_15c9"],
  ] as const)(
    "attributes a nested %s continuation to its owning v2 flow",
    async (flow, route) => {
      const path = `${route}?redirect_url=${encodeURIComponent(
        "https://private.example/callback?code=callback_private_902a",
      )}#access_token=hash_private_e83c`;

      await setupUnknownContinuation(path);

      expect(diagnosticCalls()).toStrictEqual([
        [
          AUTH_V2_DIAGNOSTIC_EVENT,
          {
            error_category: "unsupported-state",
            flow,
            method: "session",
            outcome: "failure",
            step: "recovery",
          },
        ],
      ]);
      const serializedCalls = JSON.stringify(diagnosticCalls());
      for (const prohibitedValue of [
        "private.person@example.com",
        "Private Person",
        "user_private_b21c",
        "session_private_7ed3",
        "session_token_private_49bd",
        "private-provider-task-71f0",
        "ticket_private_15c9",
        "https://private.example/callback",
        "callback_private_902a",
        "hash_private_e83c",
      ]) {
        expect(serializedCalls).not.toContain(prohibitedValue);
      }
    },
  );
});

describe("auth v2 callback privacy", () => {
  it("does not forward Clerk callback codes, messages, or payloads", async () => {
    const path =
      "/v2/sign-in/sso-callback?ticket=ticket_private_2fb1" +
      "&redirect_url=https%3A%2F%2Fprivate.example%2Ffinish%3Fcode%3Dcallback_private_5c12" +
      "#token=hash_private_902e";
    context.mocks.browser.url(`https://app.vm0.ai${path}`);
    mockSignInResource({ status: "needs_identifier" });
    mockedClerk.handleRedirectCallback.mockRejectedValueOnce({
      errors: [
        {
          code: "raw_clerk_code_private_aa31",
          identifier: "private.callback@example.com",
          longMessage: "Raw Clerk message with otp_private_102938",
          meta: {
            callbackCode: "callback_private_5c12",
            membershipId: "membership_private_6a91",
            organizationId: "org_private_77bc",
            paramName: "identifier",
            providerPayload: { arbitrary: "payload_private_bf15" },
            sessionId: "session_private_b202",
            userId: "user_private_9f44",
          },
          token: "clerk_token_private_04c7",
        },
      ],
    });

    await setupPage({
      context,
      path,
      session: null,
      user: null,
      withoutRender: true,
    });

    expect(diagnosticCalls()).toStrictEqual([
      [
        AUTH_V2_DIAGNOSTIC_EVENT,
        {
          error_category: "invalid-credentials",
          flow: "sign-in",
          method: "unknown",
          outcome: "failure",
          step: "oauth-callback",
        },
      ],
    ]);
    const serializedCalls = JSON.stringify(diagnosticCalls());
    for (const prohibitedValue of [
      "raw_clerk_code_private_aa31",
      "private.callback@example.com",
      "Raw Clerk message with otp_private_102938",
      "callback_private_5c12",
      "membership_private_6a91",
      "org_private_77bc",
      "payload_private_bf15",
      "session_private_b202",
      "user_private_9f44",
      "clerk_token_private_04c7",
      "ticket_private_2fb1",
      "https://private.example/finish",
      "hash_private_902e",
    ]) {
      expect(serializedCalls).not.toContain(prohibitedValue);
    }
  });

  it("keeps sign-up callback attribution provider-neutral and private", async () => {
    const privateProviderCode = "private_sign_up_oauth_callback_code";
    const privateProviderMessage = "Private sign-up OAuth callback detail";
    const path =
      "/v2/sign-up/sso-callback?ticket=ticket_private_sign_up_2fb1" +
      "&redirect_url=https%3A%2F%2Fprivate.example%2Ffinish%3Fcode%3Dcallback_private_sign_up_5c12" +
      "#token=hash_private_sign_up_902e";
    context.mocks.browser.url(`https://app.vm0.ai${path}`);
    mockSignUpResource({
      externalAccountError: {
        code: privateProviderCode,
        longMessage: privateProviderMessage,
        message: privateProviderMessage,
      },
      externalAccountStatus: "failed",
      status: null,
    });

    await setupPage({
      context,
      path,
      session: null,
      user: null,
      withoutRender: true,
    });

    expect(diagnosticCalls()).toStrictEqual([
      [
        AUTH_V2_DIAGNOSTIC_EVENT,
        {
          error_category: "provider-error",
          flow: "sign-up",
          method: "unknown",
          outcome: "failure",
          step: "oauth-callback",
        },
      ],
    ]);
    const serializedCalls = JSON.stringify(diagnosticCalls());
    for (const prohibitedValue of [
      privateProviderCode,
      privateProviderMessage,
      "ticket_private_sign_up_2fb1",
      "https://private.example/finish",
      "callback_private_sign_up_5c12",
      "hash_private_sign_up_902e",
    ]) {
      expect(serializedCalls).not.toContain(prohibitedValue);
    }
  });
});

describe("auth v2 PostHog privacy boundary", () => {
  it("strips automatic and arbitrary properties at the PostHog boundary", async () => {
    context.mocks.browser.url("https://app.vm0.ai/sign-in");
    await setupPage({
      context,
      path: "/sign-in",
      withoutRender: true,
    });
    initPostHog();
    const [, config] = posthog.init.mock.lastCall ?? [];
    const beforeSend = config?.before_send;
    expect(beforeSend).toBeTypeOf("function");
    if (!beforeSend) {
      throw new Error("PostHog before_send was not configured");
    }

    const sanitized = beforeSend({
      $set: { email: "set_private@example.com" },
      event: AUTH_V2_DIAGNOSTIC_EVENT,
      properties: {
        $current_url: "https://private.example/auth?ticket=url_private_81d2",
        $device_id: "device_private_3ee1",
        $host: "private.example",
        $pathname: "/auth/private_path_481a",
        $session_id: "posthog_session_private_f0a2",
        arbitrary: { provider: "payload_private_d251" },
        clerk_token: "clerk_token_private_337b",
        distinct_id: "user_private_1002",
        email: "person_private@example.com",
        error_category: "raw_error_private_66e0",
        flow: "sign-in",
        method: "raw_method_private_a59b",
        outcome: "raw_outcome_private_819d",
        step: "raw_step_private_d58f",
        token: "attacker_token_private_f830",
      },
      timestamp: "2026-08-25T00:00:00.000Z",
      uuid: "event_public_uuid",
    });

    expect(sanitized).toStrictEqual({
      event: AUTH_V2_DIAGNOSTIC_EVENT,
      properties: {
        $process_person_profile: false,
        distinct_id: "auth-v2",
        error_category: "unknown",
        flow: "sign-in",
        method: "unknown",
        outcome: "unknown",
        step: "unknown",
        token: posthogKey,
      },
      timestamp: "2026-08-25T00:00:00.000Z",
      uuid: "event_public_uuid",
    });
    const serializedEvent = JSON.stringify(sanitized);
    for (const prohibitedValue of [
      "set_private@example.com",
      "https://private.example/auth",
      "url_private_81d2",
      "device_private_3ee1",
      "private.example",
      "private_path_481a",
      "posthog_session_private_f0a2",
      "payload_private_d251",
      "clerk_token_private_337b",
      "user_private_1002",
      "person_private@example.com",
      "raw_error_private_66e0",
      "raw_method_private_a59b",
      "raw_outcome_private_819d",
      "raw_step_private_d58f",
      "attacker_token_private_f830",
    ]) {
      expect(serializedEvent).not.toContain(prohibitedValue);
    }
  });
});
