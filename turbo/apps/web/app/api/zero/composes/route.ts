import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroComposesMainContract, composesMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { createInfraClient } from "../../../../src/lib/infra-client";

const router = tsr.router(zeroComposesMainContract, {
  getByName: async ({ query, headers }) => {
    initServices();
    const client = createInfraClient(
      composesMainContract,
      headers.authorization,
    );
    const result = await client.getByName({ query });
    return { status: result.status, body: result.body };
  },
});

const handler = createHandler(zeroComposesMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-composes"),
});

export { handler as GET };
