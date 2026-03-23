import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroConnectorsMainContract, connectorsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  createInfraClient,
  forwardInfra,
} from "../../../../src/lib/infra-client";

const router = tsr.router(zeroConnectorsMainContract, {
  list: async ({ headers }, { request }) => {
    initServices();

    const orgSlug = new URL(request.url).searchParams.get("org");
    const client = createInfraClient(
      connectorsMainContract,
      headers.authorization,
      orgSlug ? { query: { org: orgSlug } } : undefined,
    );

    const result = await client.list({ headers: {} });
    return forwardInfra(result);
  },
});

const handler = createHandler(zeroConnectorsMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-connectors"),
});

export { handler as GET };
