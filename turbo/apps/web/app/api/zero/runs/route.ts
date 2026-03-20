import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroRunsMainContract, runsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../src/lib/infra-client";

const router = tsr.router(zeroRunsMainContract, {
  create: async ({ body, headers }) => {
    initServices();
    const client = createInfraClient(runsMainContract, headers.authorization);
    const result = await client.create({
      body: { ...body, triggerSource: "web" },
    });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroRunsMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs"),
});

export { handler as POST };
