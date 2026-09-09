import { command, type Command } from "ccstate";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { notFound } from "../../lib/error";
import { createPrivateHostedPreview$ } from "../services/private-hosted-preview.service";
import type { RouteEntry, SignalRouteHandler } from "../route-entry";

const preview$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(hostContract.privatePreview));
  const result = await set(
    createPrivateHostedPreview$,
    { ...params, userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  return result
    ? { status: 200 as const, body: result }
    : notFound("Hosted deployment not found");
});

const view$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(hostContract.privateView));
  const result = await set(
    createPrivateHostedPreview$,
    { ...params, userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  return result
    ? new Response(null, {
        status: 302,
        headers: {
          Location: result.url,
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
        },
      })
    : notFound("Hosted deployment not found");
});

const policy = Object.freeze({
  requiredCapability: "host:read" as const,
  requireOrganization: true as const,
  missingOrganizationStatus: 401 as const,
});

function noStore(
  handler$: Command<unknown, [AbortSignal]>,
): SignalRouteHandler<unknown> {
  return command(async ({ set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    set(setResHeader$, "Referrer-Policy", "no-referrer");
    return await set(handler$, signal);
  });
}

export const hostPrivatePreviewRoutes: readonly RouteEntry[] = [
  {
    route: hostContract.privatePreview,
    handler: noStore(authRoute(policy, preview$)),
  },
  {
    route: hostContract.privateView,
    handler: noStore(authRoute(policy, view$)),
  },
];
