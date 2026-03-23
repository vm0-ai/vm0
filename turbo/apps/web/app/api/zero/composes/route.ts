import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroComposesMainContract, composesMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
// eslint-disable-next-line web/no-self-api-call
import {
  createInfraClient,
  forwardInfra,
} from "../../../../src/lib/infra-client";

const router = tsr.router(zeroComposesMainContract, {
  getByName: async ({ query, headers }) => {
    initServices();
    const client = createInfraClient(
      composesMainContract,
      headers.authorization,
    );
    const result = await client.getByName({ query });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroComposesMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-composes"),
});

export { handler as GET };
