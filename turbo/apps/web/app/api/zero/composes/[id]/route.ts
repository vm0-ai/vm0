import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroComposesByIdContract, composesByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { createInfraClient } from "../../../../../src/lib/infra-client";

const router = tsr.router(zeroComposesByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();
    const client = createInfraClient(
      composesByIdContract,
      headers.authorization,
    );
    const result = await client.getById({ params });
    return { status: result.status, body: result.body };
  },
  delete: async ({ params, headers }) => {
    initServices();
    const client = createInfraClient(
      composesByIdContract,
      headers.authorization,
    );
    const result = await client.delete({ params, body: null });
    return { status: result.status, body: result.body };
  },
});

const handler = createHandler(zeroComposesByIdContract, router, {
  errorHandler: createSafeErrorHandler("zero-composes:id"),
});

export { handler as GET, handler as DELETE };
