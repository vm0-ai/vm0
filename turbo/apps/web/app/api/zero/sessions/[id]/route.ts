import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import {
  zeroSessionsByIdContract,
  sessionsByIdContract,
  type ApiErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
// eslint-disable-next-line web/no-self-api-call
import { createInfraClient } from "../../../../../src/lib/infra-client";

const router = tsr.router(zeroSessionsByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();

    const client = createInfraClient(
      sessionsByIdContract,
      headers.authorization,
    );

    const result = await client.getById({ params: { id: params.id } });

    if (result.status === 200) {
      return { status: 200 as const, body: result.body };
    }
    if (result.status === 401) {
      return {
        status: 401 as const,
        body: result.body as ApiErrorResponse,
      };
    }
    if (result.status === 403) {
      return {
        status: 403 as const,
        body: result.body as ApiErrorResponse,
      };
    }
    return {
      status: 404 as const,
      body: result.body as ApiErrorResponse,
    };
  },
});

const handler = createHandler(zeroSessionsByIdContract, router, {
  errorHandler: createSafeErrorHandler("zero-sessions"),
});

export { handler as GET };
