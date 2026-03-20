import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroOrgContract, orgContract, type ApiErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { createInfraClient } from "../../../../src/lib/infra-client";

const router = tsr.router(zeroOrgContract, {
  get: async ({ headers }, { request }) => {
    initServices();

    const orgSlug = new URL(request.url).searchParams.get("org");
    const client = createInfraClient(
      orgContract,
      headers.authorization,
      orgSlug ? { query: { org: orgSlug } } : undefined,
    );

    const result = await client.get();

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
      status: 404 as const,
      body: result.body as ApiErrorResponse,
    };
  },
});

const handler = createHandler(zeroOrgContract, router, {
  errorHandler: createSafeErrorHandler("zero-org"),
});

export { handler as GET };
