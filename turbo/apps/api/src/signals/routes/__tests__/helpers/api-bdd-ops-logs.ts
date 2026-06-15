import type { z } from "zod";
import { logsSearchContract } from "@vm0/api-contracts/contracts/runs";
import { userExportContract } from "@vm0/api-contracts/contracts/user-export";

import { createApp } from "../../../../app-factory";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { modelStatsContract } from "../../model-stats";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type AuthHeaders = { readonly authorization?: string };
type LogsSearchQuery = z.input<(typeof logsSearchContract.searchLogs)["query"]>;

const CRON_AUTHORIZATION = "Bearer test-cron-secret";

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "OpsLogs",
  };
}

function authenticate(
  context: TestContext,
  nextActor: ApiTestUser | null,
): AuthHeaders {
  if (!nextActor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createZeroRouteMocks(context).clerk.session(
    nextActor.userId,
    nextActor.orgId,
    nextActor.orgRole,
  );
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkUserProfile(nextActor)],
  });
  return { authorization: "Bearer clerk-session" };
}

export function createOpsLogsApi(context: TestContext) {
  return {
    async requestSearchLogs<TStatus extends 200 | 401>(
      actor: ApiTestUser | null,
      query: LogsSearchQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(logsSearchContract).searchLogs({
          headers: authenticate(context, actor),
          query,
        }),
        statuses,
      );
    },

    // The logs-search contract requires `keyword`, so the ts-rest client
    // cannot send the missing-keyword 400 case — read the route through a
    // raw app request instead.
    async rawSearchLogs(
      actor: ApiTestUser,
      queryString: string,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const { authorization } = authenticate(context, actor);
      const app = createApp({ signal: context.signal });
      const response = await app.request(`/api/logs/search${queryString}`, {
        method: "GET",
        headers: authorization === undefined ? {} : { authorization },
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    },

    async requestAggregateModelStats<TStatus extends 200 | 401>(
      auth: "valid" | "invalid",
      hours: number | undefined,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(modelStatsContract).aggregate({
          headers: {
            authorization:
              auth === "valid" ? CRON_AUTHORIZATION : "Bearer wrong-secret",
          },
          query: { hours },
        }),
        statuses,
      );
    },

    async readModelRankings(period?: string) {
      return await accept(
        setupApp({ context })(modelStatsContract).rankings({
          query: { period },
        }),
        [200],
      );
    },

    async requestGetUserExport<TStatus extends 200 | 401 | 403 | 500>(
      actor: ApiTestUser | null,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(userExportContract).get({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async requestPostUserExport<TStatus extends 202 | 401 | 403 | 429 | 500>(
      actor: ApiTestUser | null,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(userExportContract).post({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    /**
     * Holds the next `s3.send` call (the export zip PutObject) open until
     * `resolve()` is called, keeping the detached export job observable in
     * its pending/running window. Deterministic only while the export actor
     * owns no composes/threads/artifacts, so the zip put is the flow's sole
     * `s3.send` call.
     */
    deferS3PutOnce(): { readonly resolve: () => void } {
      let resolvePut = (): void => {};
      const pending = new Promise<unknown>((resolve) => {
        resolvePut = () => {
          resolve({});
        };
      });
      context.mocks.s3.send.mockReturnValueOnce(pending);
      return { resolve: resolvePut };
    },
  };
}
