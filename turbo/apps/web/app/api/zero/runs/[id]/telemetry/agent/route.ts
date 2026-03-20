import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { zeroRunAgentEventsContract, runAgentEventsContract } from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../../../../src/lib/infra-client";

const router = tsr.router(zeroRunAgentEventsContract, {
  getAgentEvents: async ({ params, query, headers }) => {
    initServices();
    const client = createInfraClient(
      runAgentEventsContract,
      headers.authorization,
    );
    const result = await client.getAgentEvents({ params, query });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroRunAgentEventsContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs:telemetry:agent"),
});

export { handler as GET };
