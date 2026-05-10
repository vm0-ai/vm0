import { command, computed } from "ccstate";
import {
  zeroComposesByIdContract,
  zeroComposesListContract,
  zeroComposesMainContract,
} from "@vm0/api-contracts/contracts/zero-composes";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { isNotFoundResponse, notFound } from "../../lib/error";
import {
  deleteCompose$,
  zeroComposeById,
  zeroComposeByName,
  zeroComposeList,
} from "../services/zero-compose-data.service";
import type { RouteEntry } from "../route";

function composeNotFound(identifier: string) {
  return notFound(`Agent compose not found: ${identifier}`);
}

const getComposeByNameInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(zeroComposesMainContract.getByName));
  const compose = await get(
    zeroComposeByName({ orgId: auth.orgId, name: query.name }),
  );
  if (!compose) {
    return composeNotFound(query.name);
  }

  return { status: 200 as const, body: compose };
});

const getComposeByIdInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroComposesByIdContract.getById));
  const compose = await get(
    zeroComposeById({
      composeId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );
  if (!compose) {
    return composeNotFound(params.id);
  }

  return { status: 200 as const, body: compose };
});

const listComposesInner$ = computed(async (get) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return {
      status: 400 as const,
      body: { error: { message: "Invalid request", code: "BAD_REQUEST" } },
    };
  }

  const result = await get(zeroComposeList(auth.orgId));
  return { status: 200 as const, body: { composes: [...result.composes] } };
});

const deleteComposeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(zeroComposesByIdContract.delete));
    signal.throwIfAborted();

    const result = await set(
      deleteCompose$,
      { composeId: params.id, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();

    if (isNotFoundResponse(result)) {
      return result;
    }
    if (result?.status === 409) {
      return result;
    }
    return { status: 204 as const, body: undefined };
  },
);

const orgAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const zeroComposesRoutes: readonly RouteEntry[] = [
  {
    route: zeroComposesMainContract.getByName,
    handler: authRoute(orgAuth, getComposeByNameInner$),
  },
  {
    route: zeroComposesListContract.list,
    handler: authRoute(
      { acceptAnySandboxCapability: true },
      listComposesInner$,
    ),
  },
  {
    route: zeroComposesByIdContract.getById,
    handler: authRoute(orgAuth, getComposeByIdInner$),
  },
  {
    route: zeroComposesByIdContract.delete,
    handler: authRoute({}, deleteComposeInner$),
  },
];
