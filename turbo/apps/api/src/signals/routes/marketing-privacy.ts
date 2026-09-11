import { timingSafeEqual } from "node:crypto";
import { command } from "ccstate";
import { marketingPrivacyContract } from "@okouai/api-contracts/contracts/marketing-privacy";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { optionalEnv } from "../../lib/env";
import { notConfigured } from "../../lib/error";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { authorizeMarketingDelivery$ } from "../services/marketing-privacy.service";
import type { RouteEntry } from "../route-entry";

const authorize$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const secret = optionalEnv("MARKETING_PRIVACY_API_SECRET");
  if (!secret || !isFeatureEnabled(FeatureSwitchKey.PrivacyChoices, {})) {
    return notConfigured("Marketing privacy verification is unavailable");
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(get(authorization$) ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return {
      status: 401 as const,
      body: {
        error: {
          code: "UNAUTHORIZED",
          message: "Marketing sender authentication is required",
        },
      },
    };
  }
  const body = await get(bodyResultOf(marketingPrivacyContract.authorize));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const decision = await set(authorizeMarketingDelivery$, body.data, signal);
  return { status: 200 as const, body: decision };
});

export const marketingPrivacyRoutes: readonly RouteEntry[] = [
  { route: marketingPrivacyContract.authorize, handler: authorize$ },
];
