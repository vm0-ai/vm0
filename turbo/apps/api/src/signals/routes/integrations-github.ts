import { integrationsGithubContract } from "@vm0/api-contracts/contracts/integrations-github";

import { authRoute } from "../auth/auth-route";
import {
  deleteGithubInstallation$,
  getGithubInstallation$,
} from "../services/integrations-github.service";
import type { RouteEntry } from "../route";

export const integrationsGithubRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubContract.getInstallation,
    handler: authRoute({}, getGithubInstallation$),
  },
  {
    route: integrationsGithubContract.deleteInstallation,
    handler: authRoute({}, deleteGithubInstallation$),
  },
];
