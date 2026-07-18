import { describe, expect, it } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import {
  mockedClerk,
  mockSignInFirstFactorVerification,
  mockSignUpEmailVerification,
  replaceMockedClerkAuthResources,
} from "../../__tests__/mock-auth.ts";
import { mockNow } from "../../__tests__/time.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

function activeEmailCode(now: number, nonce: string) {
  return {
    expireAt: new Date(now + 10 * 60 * 1000),
    nonce,
    status: "unverified" as const,
    strategy: "email_code",
  };
}

async function setupAuthSignals(path: "/sign-in" | "/sign-up"): Promise<void> {
  await setupPage({
    context,
    path,
    withoutRender: true,
    user: null,
    session: null,
    org: { activeOrg: null, memberships: [] },
  });
}

describe("clerk email code preparation", () => {
  it("reuses the active sign-up code and allows a later resend", async () => {
    let now = Date.UTC(2026, 6, 18, 8);
    mockNow(now);
    mockSignUpEmailVerification(activeEmailCode(now, "signup-initial"));

    await setupAuthSignals("/sign-up");

    const signUp = mockedClerk.client.signUp;
    await Promise.all([
      signUp.prepareEmailAddressVerification({ strategy: "email_code" }),
      signUp.prepareEmailAddressVerification({ strategy: "email_code" }),
    ]);
    expect(mockedClerk.factorPreparations).toStrictEqual([]);

    now += 60_000;
    mockNow(now);
    await signUp.prepareEmailAddressVerification({
      strategy: "email_code",
    });
    await signUp.prepareEmailAddressVerification({
      strategy: "email_code",
    });
    expect(mockedClerk.factorPreparations).toStrictEqual([
      { flow: "sign-up", strategy: "email_code" },
    ]);
  });

  it("coalesces sign-in preparation and preserves resend", async () => {
    let now = Date.UTC(2026, 6, 18, 9);
    mockNow(now);

    await setupAuthSignals("/sign-in");

    const signIn = mockedClerk.client.signIn;
    const params = {
      emailAddressId: "idn_primary",
      strategy: "email_code",
    } as const;
    const preparation = signIn.prepareFirstFactor(params);
    const concurrentPreparation = signIn.prepareFirstFactor(params);
    expect(concurrentPreparation).toBe(preparation);
    await Promise.all([preparation, concurrentPreparation]);
    await signIn.prepareFirstFactor(params);
    expect(mockedClerk.factorPreparations).toStrictEqual([
      { flow: "sign-in", strategy: "email_code" },
    ]);

    now += 60_000;
    mockNow(now);
    await signIn.prepareFirstFactor(params);
    expect(mockedClerk.factorPreparations).toStrictEqual([
      { flow: "sign-in", strategy: "email_code" },
      { flow: "sign-in", strategy: "email_code" },
    ]);
  });

  it("preserves sign-in resend state across replacement resources", async () => {
    let now = Date.UTC(2026, 6, 18, 9, 30);
    mockNow(now);

    await setupAuthSignals("/sign-in");

    const params = {
      emailAddressId: "idn_primary",
      strategy: "email_code",
    } as const;
    const initialSignIn = mockedClerk.client.signIn;
    await initialSignIn.prepareFirstFactor(params);
    replaceMockedClerkAuthResources({
      signInVerification: initialSignIn.firstFactorVerification,
    });

    now += 60_000;
    mockNow(now);
    await mockedClerk.client.signIn.prepareFirstFactor(params);

    expect(mockedClerk.factorPreparations).toStrictEqual([
      { flow: "sign-in", strategy: "email_code" },
      { flow: "sign-in", strategy: "email_code" },
    ]);
  });

  it("prepares a code for a different sign-in email factor", async () => {
    const now = Date.UTC(2026, 6, 18, 9, 45);
    mockNow(now);

    await setupAuthSignals("/sign-in");

    const signIn = mockedClerk.client.signIn;
    await signIn.prepareFirstFactor({
      emailAddressId: "idn_primary",
      strategy: "email_code",
    });
    await signIn.prepareFirstFactor({
      emailAddressId: "idn_secondary",
      strategy: "email_code",
    });

    expect(mockedClerk.factorPreparations).toStrictEqual([
      { flow: "sign-in", strategy: "email_code" },
      { flow: "sign-in", strategy: "email_code" },
    ]);
  });

  it("prepares expired and non-email sign-in factors", async () => {
    const now = Date.UTC(2026, 6, 18, 10);
    mockNow(now);
    mockSignInFirstFactorVerification({
      expireAt: new Date(now - 1),
      nonce: "expired-email-code",
      status: "unverified",
      strategy: "email_code",
    });

    await setupAuthSignals("/sign-in");

    const signIn = mockedClerk.client.signIn;
    await signIn.prepareFirstFactor({
      emailAddressId: "idn_primary",
      strategy: "email_code",
    });
    await signIn.prepareFirstFactor({
      phoneNumberId: "idn_phone",
      strategy: "phone_code",
    });

    expect(mockedClerk.factorPreparations).toStrictEqual([
      { flow: "sign-in", strategy: "email_code" },
      { flow: "sign-in", strategy: "phone_code" },
    ]);
  });

  it("passes through sign-up email-link preparation", async () => {
    const now = Date.UTC(2026, 6, 18, 10, 30);
    mockNow(now);
    mockSignUpEmailVerification(activeEmailCode(now, "active-email-code"));

    await setupAuthSignals("/sign-up");

    await mockedClerk.client.signUp.prepareEmailAddressVerification({
      redirectUrl: "https://app.vm0.ai/sign-up/verify",
      strategy: "email_link",
    });

    expect(mockedClerk.factorPreparations).toStrictEqual([
      { flow: "sign-up", strategy: "email_link" },
    ]);
  });

  it("guards replacement Clerk authentication resources", async () => {
    const now = Date.UTC(2026, 6, 18, 11);
    mockNow(now);

    await setupAuthSignals("/sign-up");

    replaceMockedClerkAuthResources({
      signUpVerification: activeEmailCode(now, "replacement-code"),
    });
    await mockedClerk.client.signUp.prepareEmailAddressVerification({
      strategy: "email_code",
    });

    expect(mockedClerk.factorPreparations).toStrictEqual([]);
  });
});
