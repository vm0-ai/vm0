import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroComposesListContract, composesListContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../../src/lib/infra-client";

const router = tsr.router(zeroComposesListContract, {
  list: async ({ query, headers }) => {
    initServices();
    const client = createInfraClient(
      composesListContract,
      headers.authorization,
    );
    const result = await client.list({ query });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroComposesListContract, router, {
  errorHandler: createSafeErrorHandler("zero-composes:list"),
});

export { handler as GET };
