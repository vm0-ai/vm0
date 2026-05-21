import { command } from "ccstate";
import { integrationsGithubContract } from "@vm0/api-contracts/contracts/integrations-github";

import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  connectGithubUser$,
  createGithubLabelListener$,
  deleteGithubLabelListener$,
  deleteGithubInstallation$,
  disconnectGithubUser$,
  getGithubInstallation$,
  updateGithubLabelListener$,
  updateGithubInstallation$,
} from "../services/integrations-github.service";
import type { RouteEntry } from "../route";

const updateInstallationBody$ = bodyResultOf(
  integrationsGithubContract.updateInstallation,
);
const createLabelListenerBody$ = bodyResultOf(
  integrationsGithubContract.createLabelListener,
);
const updateLabelListenerBody$ = bodyResultOf(
  integrationsGithubContract.updateLabelListener,
);
const updateLabelListenerParams$ = pathParamsOf(
  integrationsGithubContract.updateLabelListener,
);
const deleteLabelListenerParams$ = pathParamsOf(
  integrationsGithubContract.deleteLabelListener,
);

const agentNameRequired = Object.freeze({
  status: 400 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "agentName is required",
      code: "BAD_REQUEST",
    }),
  }),
});

const updateGithubInstallationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(updateInstallationBody$);
    signal.throwIfAborted();

    if (!body.ok) {
      return agentNameRequired;
    }

    const result = await set(
      updateGithubInstallation$,
      { agentName: body.data.agentName },
      signal,
    );
    signal.throwIfAborted();

    return result;
  },
);

const createGithubLabelListenerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(createLabelListenerBody$);
    signal.throwIfAborted();

    if (!body.ok) {
      return body.response;
    }

    const result = await set(createGithubLabelListener$, body.data, signal);
    signal.throwIfAborted();

    return result;
  },
);

const updateGithubLabelListenerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(updateLabelListenerBody$);
    signal.throwIfAborted();
    const params = get(updateLabelListenerParams$);

    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      updateGithubLabelListener$,
      { listenerId: params.listenerId, body: body.data },
      signal,
    );
    signal.throwIfAborted();

    return result;
  },
);

const deleteGithubLabelListenerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(deleteLabelListenerParams$);
    const result = await set(
      deleteGithubLabelListener$,
      { listenerId: params.listenerId },
      signal,
    );
    signal.throwIfAborted();

    return result;
  },
);

export const integrationsGithubRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubContract.getInstallation,
    handler: authRoute({ requireOrganization: true }, getGithubInstallation$),
  },
  {
    route: integrationsGithubContract.connectUser,
    handler: authRoute({ requireOrganization: true }, connectGithubUser$),
  },
  {
    route: integrationsGithubContract.disconnectUser,
    handler: authRoute({ requireOrganization: true }, disconnectGithubUser$),
  },
  {
    route: integrationsGithubContract.deleteInstallation,
    handler: authRoute(
      { requireOrganization: true },
      deleteGithubInstallation$,
    ),
  },
  {
    route: integrationsGithubContract.updateInstallation,
    handler: authRoute(
      { requireOrganization: true },
      updateGithubInstallationInner$,
    ),
  },
  {
    route: integrationsGithubContract.createLabelListener,
    handler: authRoute(
      { requireOrganization: true },
      createGithubLabelListenerInner$,
    ),
  },
  {
    route: integrationsGithubContract.updateLabelListener,
    handler: authRoute(
      { requireOrganization: true },
      updateGithubLabelListenerInner$,
    ),
  },
  {
    route: integrationsGithubContract.deleteLabelListener,
    handler: authRoute(
      { requireOrganization: true },
      deleteGithubLabelListenerInner$,
    ),
  },
];
