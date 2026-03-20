import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  zeroConnectorsMainContract,
  connectorsMainContract,
  type ApiErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { createInfraClient } from "../../../../src/lib/infra-client";

const router = tsr.router(zeroConnectorsMainContract, {
  list: async ({ headers }, { request }) => {
    initServices();

    const orgSlug = new URL(request.url).searchParams.get("org");
    const client = createInfraClient(
      connectorsMainContract,
      headers.authorization,
      orgSlug ? { query: { org: orgSlug } } : undefined,
    );

    const result = await client.list();

    if (result.status === 200) {
      return { status: 200 as const, body: result.body };
    }
    if (result.status === 401) {
      return {
        status: 401 as const,
        body: result.body as ApiErrorResponse,
      };
    }
    return {
      status: 500 as const,
      body: result.body as ApiErrorResponse,
    };
  },
});

const handler = createHandler(zeroConnectorsMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-connectors"),
});

export { handler as GET };
