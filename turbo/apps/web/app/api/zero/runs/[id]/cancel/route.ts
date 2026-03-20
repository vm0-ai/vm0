import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { zeroRunsCancelContract, runsCancelContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { createInfraClient } from "../../../../../../src/lib/infra-client";

const router = tsr.router(zeroRunsCancelContract, {
  cancel: async ({ params, headers }) => {
    initServices();
    const client = createInfraClient(runsCancelContract, headers.authorization);
    const result = await client.cancel({ params, body: undefined });
    return { status: result.status, body: result.body };
  },
});

const handler = createHandler(zeroRunsCancelContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs:cancel"),
});

export { handler as POST };
