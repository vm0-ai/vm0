import { command } from "ccstate";
import { integrationsGithubContract } from "@vm0/api-contracts/contracts/integrations-github";

import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  connectGithubUser$,
  getGithubInstallation$,
} from "../services/integrations-github.service";
import type { RouteEntry } from "../route-entry";

const githubReadAuth = {
  requireOrganization: true,
  requiredCapability: "github:read",
} as const;

const connectUserBody$ = bodyResultOf(integrationsGithubContract.connectUser);

const connectGithubUserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(connectUserBody$);
    signal.throwIfAborted();

    if (!body.ok) {
      return body.response;
    }

    const result = await set(connectGithubUser$, body.data, signal);
    signal.throwIfAborted();

    return result;
  },
);

export const integrationsGithubRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubContract.getInstallation,
    handler: authRoute(githubReadAuth, getGithubInstallation$),
  },
  {
    route: integrationsGithubContract.connectUser,
    handler: authRoute({ requireOrganization: true }, connectGithubUserInner$),
  },
];
