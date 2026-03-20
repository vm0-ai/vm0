import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroSchedulesMainContract, schedulesMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { createInfraClient } from "../../../../src/lib/infra-client";

const router = tsr.router(zeroSchedulesMainContract, {
  deploy: async ({ body, headers }) => {
    initServices();
    const client = createInfraClient(
      schedulesMainContract,
      headers.authorization,
    );
    const result = await client.deploy({ body });
    return { status: result.status, body: result.body };
  },
  list: async ({ headers }) => {
    initServices();
    const client = createInfraClient(
      schedulesMainContract,
      headers.authorization,
    );
    const result = await client.list({ headers: {} });
    if (result.status === 200)
      return { status: 200 as const, body: result.body };
    if (result.status === 401)
      return { status: 401 as const, body: result.body };
    if (result.status === 403)
      return { status: 403 as const, body: result.body };
    return { status: result.status, body: result.body };
  },
});

const handler = createHandler(zeroSchedulesMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-schedules"),
});

export { handler as GET, handler as POST };
