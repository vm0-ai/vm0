import type {
  PrepareSecondFactorParams,
  SignInResource,
  SignInSecondFactor,
} from "@clerk/react/types";

export type AuthV2SignInSecondFactor = Extract<
  SignInSecondFactor,
  { strategy: "email_code" | "phone_code" | "totp" | "backup_code" }
> & {
  readonly id: string;
  readonly kind: "second-factor";
};

export function isAuthV2SecondFactorStatus(status: string | null): boolean {
  // Older Clerk instances also use needs_second_factor for Device Trust.
  return status === "needs_client_trust" || status === "needs_second_factor";
}

export function discoverAuthV2SecondFactors(
  resource: SignInResource,
): readonly AuthV2SignInSecondFactor[] {
  const factors: AuthV2SignInSecondFactor[] = [];
  for (const factor of resource.supportedSecondFactors ?? []) {
    if (factor.strategy === "email_code") {
      factors.push({
        ...factor,
        // Preserve the existing email resend cooldown across app updates.
        id: `client-trust-email-code:${factor.emailAddressId}`,
        kind: "second-factor",
      });
    } else if (factor.strategy === "phone_code") {
      factors.push({
        ...factor,
        id: `second-factor-phone-code:${factor.phoneNumberId}`,
        kind: "second-factor",
      });
    } else if (
      resource.status === "needs_second_factor" &&
      (factor.strategy === "totp" || factor.strategy === "backup_code")
    ) {
      factors.push({
        ...factor,
        id: `second-factor:${factor.strategy}`,
        kind: "second-factor",
      });
    }
  }
  return factors;
}

export function authV2SecondFactorPreparation(
  factor: AuthV2SignInSecondFactor,
): PrepareSecondFactorParams | null {
  if (factor.strategy === "email_code") {
    return { emailAddressId: factor.emailAddressId, strategy: "email_code" };
  }
  if (factor.strategy === "phone_code") {
    return { phoneNumberId: factor.phoneNumberId, strategy: "phone_code" };
  }
  return null;
}
