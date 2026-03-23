import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import {
  zeroSchedulesByNameContract,
  schedulesByNameContract,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../../src/lib/infra-client";

const router = tsr.router(zeroSchedulesByNameContract, {
  delete: async ({ params, query, headers }) => {
    initServices();
    const client = createInfraClient(
      schedulesByNameContract,
      headers.authorization,
    );
    const result = await client.delete({ params, query });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroSchedulesByNameContract, router, {
  errorHandler: createSafeErrorHandler("zero-schedules:name"),
});

export { handler as DELETE };
