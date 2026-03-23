import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroRunsQueueContract, runsQueueContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../../src/lib/infra-client";

const router = tsr.router(zeroRunsQueueContract, {
  getQueue: async ({ headers }) => {
    initServices();
    const client = createInfraClient(runsQueueContract, headers.authorization);
    const result = await client.getQueue({ headers: {} });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroRunsQueueContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs:queue"),
});

export { handler as GET };
