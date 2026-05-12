import { command } from "ccstate";
import { integrationsGithubContract } from "@vm0/api-contracts/contracts/integrations-github";

import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  deleteGithubInstallation$,
  getGithubInstallation$,
  updateGithubInstallation$,
} from "../services/integrations-github.service";
import type { RouteEntry } from "../route";

const updateInstallationBody$ = bodyResultOf(
  integrationsGithubContract.updateInstallation,
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

export const integrationsGithubRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubContract.getInstallation,
    handler: authRoute({}, getGithubInstallation$),
  },
  {
    route: integrationsGithubContract.deleteInstallation,
    handler: authRoute({}, deleteGithubInstallation$),
  },
  {
    route: integrationsGithubContract.updateInstallation,
    handler: authRoute({}, updateGithubInstallationInner$),
  },
];
