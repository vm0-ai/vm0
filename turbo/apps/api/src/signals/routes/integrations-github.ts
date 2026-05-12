import { integrationsGithubContract } from "@vm0/api-contracts/contracts/integrations-github";

import { authRoute } from "../auth/auth-route";
import { deleteGithubInstallation$ } from "../services/integrations-github.service";
import type { RouteEntry } from "../route";

export const integrationsGithubRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubContract.deleteInstallation,
    handler: authRoute({}, deleteGithubInstallation$),
  },
];
