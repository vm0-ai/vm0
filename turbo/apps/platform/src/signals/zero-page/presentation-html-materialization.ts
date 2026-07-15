import {
  zeroHostContract,
  type MaterializedPresentationHtmlResponse,
} from "@vm0/api-contracts/contracts/zero-host";

import { accept } from "../../lib/accept.ts";
import type { ZeroClientFactory } from "../api-client.ts";

export async function materializePresentationHtml(params: {
  readonly createClient: ZeroClientFactory;
  readonly signal: AbortSignal;
  readonly toastError: boolean;
  readonly url: string;
}): Promise<MaterializedPresentationHtmlResponse> {
  params.signal.throwIfAborted();
  const client = params.createClient(zeroHostContract, { apiBase: "api" });
  const response = await accept(
    client.materializePresentationHtml({
      body: { url: params.url },
      fetchOptions: { signal: params.signal },
    }),
    [200],
    { toast: params.toastError },
  );
  params.signal.throwIfAborted();
  return response.body;
}
