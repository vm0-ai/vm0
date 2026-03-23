import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroComposesByIdContract, composesByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../../src/lib/infra-client";

const router = tsr.router(zeroComposesByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();
    const client = createInfraClient(
      composesByIdContract,
      headers.authorization,
    );
    const result = await client.getById({ params });
    return forwardInfra(result);
  },
  delete: async ({ params, headers }) => {
    initServices();
    const client = createInfraClient(
      composesByIdContract,
      headers.authorization,
    );
    const result = await client.delete({ params });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroComposesByIdContract, router, {
  errorHandler: createSafeErrorHandler("zero-composes:id"),
});

export { handler as GET, handler as DELETE };
