import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroOrgContract, orgContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../src/lib/infra-client";

const router = tsr.router(zeroOrgContract, {
  get: async ({ headers }, { request }) => {
    initServices();

    const orgSlug = new URL(request.url).searchParams.get("org");
    const client = createInfraClient(
      orgContract,
      headers.authorization,
      orgSlug ? { query: { org: orgSlug } } : undefined,
    );

    const result = await client.get({ headers: {} });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroOrgContract, router, {
  errorHandler: createSafeErrorHandler("zero-org"),
});

export { handler as GET };
