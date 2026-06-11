import type { z } from "zod";
import {
  runAgentEventsContract,
  runEventsContract,
  runMetricsContract,
  runNetworkLogsContract,
  runsByIdContract,
  runsCancelContract,
  runsMainContract,
  runsQueueContract,
  runSystemLogContract,
  runTelemetryContract,
} from "@vm0/api-contracts/contracts/runs";
import {
  checkpointsByIdContract,
  sessionsByIdContract,
} from "@vm0/api-contracts/contracts/sessions";
import {
  logsByIdContract,
  logsListContract,
} from "@vm0/api-contracts/contracts/logs";
import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";
import {
  zeroRunAgentEventsContract,
  zeroRunNetworkLogsContract,
} from "@vm0/api-contracts/contracts/zero-runs";

import { createApp } from "../../../../app-factory";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type AuthHeaders = { readonly authorization?: string };
type DirectRunRequest = z.input<(typeof runsMainContract.create)["body"]>;
type RunsListQuery = z.input<(typeof runsMainContract.list)["query"]>;
type RunEventsQuery = z.input<(typeof runEventsContract.getEvents)["query"]>;
type PagedTelemetryQuery = z.input<
  (typeof runAgentEventsContract.getAgentEvents)["query"]
>;
type ZeroAgentEventsQuery = z.input<
  (typeof zeroRunAgentEventsContract.getAgentEvents)["query"]
>;
type ZeroNetworkLogsQuery = z.input<
  (typeof zeroRunNetworkLogsContract.getNetworkLogs)["query"]
>;
type LogsListQuery = z.input<(typeof logsListContract.list)["query"]>;

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
    lastName: "RunReads",
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

export function createRunReadsApi(context: TestContext) {
  return {
    async requestCreateDirectRun<
      TStatus extends 201 | 400 | 401 | 403 | 404 | 429,
    >(
      actor: ApiTestUser | null,
      body: DirectRunRequest,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runsMainContract).create({
          headers: authenticate(context, actor),
          body,
        }),
        statuses,
      );
    },

    async requestListAgentRuns<TStatus extends 200 | 400 | 401>(
      actor: ApiTestUser | null,
      query: RunsListQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runsMainContract).list({
          headers: authenticate(context, actor),
          query,
        }),
        statuses,
      );
    },

    async requestReadAgentRun<TStatus extends 200 | 400 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    /** Reads a run detail with a raw bearer credential (sandbox token). */
    async requestReadAgentRunAs<TStatus extends 200 | 400 | 401 | 404>(
      authorization: string,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runsByIdContract).getById({
          headers: { authorization },
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestReadAgentRunQueue<TStatus extends 200 | 401>(
      actor: ApiTestUser | null,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runsQueueContract).getQueue({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async requestCancelAgentRun<TStatus extends 200 | 400 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runsCancelContract).cancel({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    /** Cancels through the agent route with a raw bearer credential. */
    async requestCancelAgentRunAs<TStatus extends 200 | 400 | 401 | 404>(
      authorization: string,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runsCancelContract).cancel({
          headers: { authorization },
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestReadSession<TStatus extends 200 | 401 | 403 | 404>(
      actor: ApiTestUser | null,
      sessionId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(sessionsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id: sessionId },
        }),
        statuses,
      );
    },

    async requestReadCheckpoint<TStatus extends 200 | 401 | 403 | 404>(
      actor: ApiTestUser | null,
      checkpointId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(checkpointsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id: checkpointId },
        }),
        statuses,
      );
    },

    async requestRunEvents<TStatus extends 200 | 400 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      query: RunEventsQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runEventsContract).getEvents({
          headers: authenticate(context, actor),
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    /** Reads run events with a raw bearer credential (sandbox token). */
    async requestRunEventsAs<TStatus extends 200 | 400 | 401 | 404>(
      authorization: string,
      runId: string,
      query: RunEventsQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runEventsContract).getEvents({
          headers: { authorization },
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    async requestRunTelemetry<TStatus extends 200 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runTelemetryContract).getTelemetry({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    async requestRunAgentEvents<TStatus extends 200 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      query: PagedTelemetryQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runAgentEventsContract).getAgentEvents({
          headers: authenticate(context, actor),
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    async requestRunSystemLog<TStatus extends 200 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      query: PagedTelemetryQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runSystemLogContract).getSystemLog({
          headers: authenticate(context, actor),
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    async requestRunMetrics<TStatus extends 200 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      query: PagedTelemetryQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runMetricsContract).getMetrics({
          headers: authenticate(context, actor),
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    async requestRunNetworkLogs<TStatus extends 200 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      query: PagedTelemetryQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(runNetworkLogsContract).getNetworkLogs({
          headers: authenticate(context, actor),
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    async requestZeroRunAgentEvents<
      TStatus extends 200 | 400 | 401 | 403 | 404,
    >(
      actor: ApiTestUser | null,
      runId: string,
      query: ZeroAgentEventsQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(zeroRunAgentEventsContract).getAgentEvents({
          headers: authenticate(context, actor),
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    async requestZeroRunNetworkLogs<
      TStatus extends 200 | 400 | 401 | 403 | 404,
    >(
      actor: ApiTestUser | null,
      runId: string,
      query: ZeroNetworkLogsQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(zeroRunNetworkLogsContract).getNetworkLogs({
          headers: authenticate(context, actor),
          params: { id: runId },
          query,
        }),
        statuses,
      );
    },

    async requestQueuePosition<TStatus extends 200 | 400 | 401 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(zeroQueuePositionContract).getPosition({
          headers: authenticate(context, actor),
          query: { runId },
        }),
        statuses,
      );
    },

    async requestListLogs<TStatus extends 200 | 401>(
      actor: ApiTestUser | null,
      query: LogsListQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(logsListContract).list({
          headers: authenticate(context, actor),
          query,
        }),
        statuses,
      );
    },

    /** Lists logs with a raw bearer credential (run-scoped zero token). */
    async requestListLogsAs<TStatus extends 200 | 401 | 403>(
      authorization: string,
      query: LogsListQuery,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(logsListContract).list({
          headers: { authorization },
          query,
        }),
        statuses,
      );
    },

    async requestReadLogById<TStatus extends 200 | 401 | 403 | 404>(
      actor: ApiTestUser | null,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(logsByIdContract).getById({
          headers: authenticate(context, actor),
          params: { id: runId },
        }),
        statuses,
      );
    },

    /** Reads one log detail with a raw bearer credential (zero token). */
    async requestReadLogByIdAs<TStatus extends 200 | 401 | 403 | 404>(
      authorization: string,
      runId: string,
      statuses: readonly TStatus[],
    ) {
      return await accept(
        setupApp({ context })(logsByIdContract).getById({
          headers: { authorization },
          params: { id: runId },
        }),
        statuses,
      );
    },

    // Raw GET for 400s the ts-rest contracts cannot express (queue-position
    // without runId, telemetry queries rejected by zod before the handler).
    // Modeled on rawSearchLogs in helpers/api-bdd-ops-logs.ts.
    async rawApiRequest(
      actor: ApiTestUser | null,
      path: string,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const { authorization } = authenticate(context, actor);
      const app = createApp({ signal: context.signal });
      const response = await app.request(path, {
        method: "GET",
        headers: authorization === undefined ? {} : { authorization },
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    },

    // Raw POST for the direct-run invalid-body 400 (the create contract
    // requires `prompt`, so the typed client cannot send the malformed body).
    async rawCreateDirectRun(
      actor: ApiTestUser,
      body: unknown,
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      const { authorization } = authenticate(context, actor);
      const app = createApp({ signal: context.signal });
      const response = await app.request("/api/agent/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: JSON.stringify(body),
      });
      const responseBody: unknown = await response.json();
      return { status: response.status, body: responseBody };
    },
  };
}
