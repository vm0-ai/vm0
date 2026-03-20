import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import {
  zeroConnectorsByTypeContract,
  connectorsByTypeContract,
  type ApiErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { createInfraClient } from "../../../../../src/lib/infra-client";

const router = tsr.router(zeroConnectorsByTypeContract, {
  delete: async ({ params, headers }, { request }) => {
    initServices();

    const orgSlug = new URL(request.url).searchParams.get("org");
    const client = createInfraClient(
      connectorsByTypeContract,
      headers.authorization,
      orgSlug ? { query: { org: orgSlug } } : undefined,
    );

    const result = await client.delete({ params: { type: params.type } });

    if (result.status === 204) {
      return { status: 204 as const, body: undefined };
    }
    if (result.status === 401) {
      return {
        status: 401 as const,
        body: result.body as ApiErrorResponse,
      };
    }
    return {
      status: 404 as const,
      body: result.body as ApiErrorResponse,
    };
  },
});

const handler = createHandler(zeroConnectorsByTypeContract, router, {
  errorHandler: createSafeErrorHandler("zero-connectors:type"),
});

export { handler as DELETE };
