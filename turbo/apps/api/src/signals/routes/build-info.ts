import { command } from "ccstate";
import type { BuildInfoRouteResponse } from "@vm0/api-contracts/contracts";

import { getBuildVersion, normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";
import { setResHeader$ } from "../context/hono";

export const apiBuildInfo$ = command(
  ({ set }, _signal: AbortSignal): BuildInfoRouteResponse => {
    set(setResHeader$, "Cache-Control", "no-store");

    return {
      status: 200,
      body: {
        commitSha: normalizeBuildCommitSha(env("GIT_COMMIT_SHA")),
        version: getBuildVersion(),
      },
    };
  },
);
