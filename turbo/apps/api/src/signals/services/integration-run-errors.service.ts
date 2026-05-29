import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import type { Setter } from "ccstate";

import { env } from "../../lib/env";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";

function addCreditsUrl(): string {
  const appUrl = env("APP_URL").replace(/\/$/, "");
  return `${appUrl}/?settings=billing&billingView=credits`;
}

export async function formatIntegrationRunError(args: {
  readonly set: Setter;
  readonly orgId: string;
  readonly userId: string;
  readonly code: string;
  readonly message: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  if (args.code !== "INSUFFICIENT_CREDITS") {
    return formatRunErrorForExternalSurface({
      code: args.code,
      message: args.message,
    });
  }

  const membership = await args.set(
    getMemberRoleAndUpdateCache$,
    args.orgId,
    args.userId,
    args.signal,
  );
  args.signal.throwIfAborted();

  return formatRunErrorForExternalSurface({
    code: args.code,
    message: args.message,
    insufficientCredits: {
      canManageBilling: membership?.role === "admin",
      addCreditsUrl: addCreditsUrl(),
    },
  });
}
