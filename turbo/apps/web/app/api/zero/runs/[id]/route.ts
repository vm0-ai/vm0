import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroRunsByIdContract, runsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../../src/lib/infra-client";

const router = tsr.router(zeroRunsByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();
    const client = createInfraClient(runsByIdContract, headers.authorization);
    const result = await client.getById({ params });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroRunsByIdContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs:id"),
});

export { handler as GET };
