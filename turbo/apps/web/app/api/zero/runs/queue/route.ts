import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroRunsQueueContract, runsQueueContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { createInfraClient } from "../../../../../src/lib/infra-client";

const router = tsr.router(zeroRunsQueueContract, {
  getQueue: async ({ headers }) => {
    initServices();
    const client = createInfraClient(runsQueueContract, headers.authorization);
    const result = await client.getQueue({ headers: {} });
    if (result.status === 200)
      return { status: 200 as const, body: result.body };
    if (result.status === 401)
      return { status: 401 as const, body: result.body };
    if (result.status === 403)
      return { status: 403 as const, body: result.body };
    return { status: result.status, body: result.body };
  },
});

const handler = createHandler(zeroRunsQueueContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs:queue"),
});

export { handler as GET };
