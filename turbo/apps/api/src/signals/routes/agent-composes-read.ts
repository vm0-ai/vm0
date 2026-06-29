import { computed } from "ccstate";
import {
  composesListContract,
  composesMainContract,
  composesVersionsContract,
} from "@vm0/api-contracts/contracts/composes";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  agentComposeByName,
  agentComposeList,
  agentComposeVersionResolution,
} from "../services/agent-composes-read.service";
import type { RouteEntry } from "../route-entry";

const getComposeByNameInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const query = get(queryOf(composesMainContract.getByName));
  if (!auth.orgId) {
    return notFound(`Agent compose not found: ${query.name}`);
  }

  const compose = await get(
    agentComposeByName({ orgId: auth.orgId, name: query.name }),
  );
  if (!compose) {
    return notFound(`Agent compose not found: ${query.name}`);
  }

  return { status: 200 as const, body: compose };
});

const listComposesInner$ = computed(async (get) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return badRequestMessage("Invalid request");
  }

  const result = await get(agentComposeList(auth.orgId));
  return { status: 200 as const, body: { composes: [...result.composes] } };
});

const resolveComposeVersionInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const query = get(queryOf(composesVersionsContract.resolveVersion));
  const result = await get(
    agentComposeVersionResolution({
      composeId: query.composeId,
      userId: auth.userId,
      version: query.version,
    }),
  );

  if ("status" in result) {
    return result;
  }

  return { status: 200 as const, body: result };
});

const anySandboxAuth = {
  acceptAnySandboxCapability: true,
} as const;

export const agentComposesReadRoutes: readonly RouteEntry[] = [
  {
    route: composesMainContract.getByName,
    handler: authRoute(anySandboxAuth, getComposeByNameInner$),
  },
  {
    route: composesListContract.list,
    handler: authRoute(anySandboxAuth, listComposesInner$),
  },
  {
    route: composesVersionsContract.resolveVersion,
    handler: authRoute(anySandboxAuth, resolveComposeVersionInner$),
  },
];
