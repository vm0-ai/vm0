import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroSchedulesMainContract, schedulesMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../src/lib/infra-client";

const router = tsr.router(zeroSchedulesMainContract, {
  deploy: async ({ body, headers }) => {
    initServices();
    const client = createInfraClient(
      schedulesMainContract,
      headers.authorization,
    );
    const result = await client.deploy({ body });
    return forwardInfra(result);
  },
  list: async ({ headers }) => {
    initServices();
    const client = createInfraClient(
      schedulesMainContract,
      headers.authorization,
    );
    const result = await client.list({ headers: {} });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroSchedulesMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-schedules"),
});

export { handler as GET, handler as POST };
