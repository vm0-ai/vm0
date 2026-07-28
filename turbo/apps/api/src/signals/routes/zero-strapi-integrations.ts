import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { zeroStrapiIntegrationsContract } from "@vm0/api-contracts/contracts/zero-strapi-integrations";
import { command, computed } from "ccstate";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry, SignalRouteHandler } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  checkStrapiIntegrationTest,
  createStrapiIntegration,
  listStrapiIntegrations,
  removeStrapiIntegration,
  revealStrapiIntegrationSecret,
} from "../services/strapi-integration.service";

const strapiIntegrationAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

const strapiIntegrationDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Strapi integration is not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

function adminRequired() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Only organization admins can configure Strapi",
        code: "FORBIDDEN" as const,
      },
    },
  };
}

const strapiIntegrationEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.StrapiIntegration, context);
});

const list$ = computed(async (get) => {
  if (!(await get(strapiIntegrationEnabled$))) {
    return strapiIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  return {
    status: 200 as const,
    body: [...(await listStrapiIntegrations(get(db$), auth.orgId))],
  };
});

const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(strapiIntegrationEnabled$))) {
    return strapiIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired();
  }
  const bodyResult = await get(
    bodyResultOf(zeroStrapiIntegrationsContract.create),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await createStrapiIntegration({
    db: set(writeDb$),
    orgId: auth.orgId,
    userId: auth.userId,
    name: bodyResult.data.name,
    baseUrl: bodyResult.data.baseUrl,
  });
  signal.throwIfAborted();
  if (result.kind === "bad_request") {
    return badRequestMessage(
      "Strapi URL must be an HTTP or HTTPS URL without credentials, query, or fragment",
    );
  }
  if (result.kind === "conflict") {
    return conflict("This Strapi instance is already connected");
  }
  return { status: 201 as const, body: result.integration };
});

const revealSecret$ = computed(async (get) => {
  if (!(await get(strapiIntegrationEnabled$))) {
    return strapiIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired();
  }
  const params = get(pathParamsOf(zeroStrapiIntegrationsContract.revealSecret));
  const secret = await revealStrapiIntegrationSecret(get(db$), {
    orgId: auth.orgId,
    integrationId: params.integrationId,
  });
  return secret
    ? { status: 200 as const, body: secret }
    : notFound("Strapi integration not found");
});

const checkTest$ = computed(async (get) => {
  if (!(await get(strapiIntegrationEnabled$))) {
    return strapiIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired();
  }
  const params = get(pathParamsOf(zeroStrapiIntegrationsContract.checkTest));
  const result = await checkStrapiIntegrationTest(get(db$), {
    orgId: auth.orgId,
    integrationId: params.integrationId,
  });
  return result
    ? { status: 200 as const, body: result }
    : notFound("Strapi integration not found");
});

const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(strapiIntegrationEnabled$))) {
    return strapiIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired();
  }
  const params = get(pathParamsOf(zeroStrapiIntegrationsContract.remove));
  const result = await removeStrapiIntegration({
    db: set(writeDb$),
    orgId: auth.orgId,
    integrationId: params.integrationId,
  });
  signal.throwIfAborted();
  if (result === "in_use") {
    return conflict(
      "Delete the workflow automations using this Strapi integration first",
    );
  }
  if (result === "not_found") {
    return notFound("Strapi integration not found");
  }
  return { status: 204 as const, body: undefined };
});

const handlers: Readonly<
  Record<
    keyof typeof zeroStrapiIntegrationsContract,
    SignalRouteHandler<unknown>
  >
> = {
  list: authRoute(strapiIntegrationAuth, list$),
  create: authRoute(strapiIntegrationAuth, create$),
  revealSecret: authRoute(strapiIntegrationAuth, revealSecret$),
  checkTest: authRoute(strapiIntegrationAuth, checkTest$),
  remove: authRoute(strapiIntegrationAuth, remove$),
};

export const zeroStrapiIntegrationsRoutes: readonly RouteEntry[] = [
  { route: zeroStrapiIntegrationsContract.list, handler: handlers.list },
  { route: zeroStrapiIntegrationsContract.create, handler: handlers.create },
  {
    route: zeroStrapiIntegrationsContract.revealSecret,
    handler: handlers.revealSecret,
  },
  {
    route: zeroStrapiIntegrationsContract.checkTest,
    handler: handlers.checkTest,
  },
  { route: zeroStrapiIntegrationsContract.remove, handler: handlers.remove },
];
