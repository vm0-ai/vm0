import { initClient } from "@ts-rest/core";
import { zeroDeveloperSupportContract } from "@vm0/core/contracts/zero-developer-support";
import { getClientConfig, handleError } from "../core/client-factory";

export async function requestDeveloperSupportConsent(body: {
  title: string;
  description: string;
}): Promise<{ consentCode: string }> {
  const config = await getClientConfig();
  const client = initClient(zeroDeveloperSupportContract, config);
  const result = await client.submit({ body, headers: {} });
  if (result.status === 200) return result.body as { consentCode: string };
  handleError(result, "Failed to request developer support consent");
}

export async function submitDeveloperSupport(body: {
  title: string;
  description: string;
  consentCode: string;
}): Promise<{ reference: string }> {
  const config = await getClientConfig();
  const client = initClient(zeroDeveloperSupportContract, config);
  const result = await client.submit({ body, headers: {} });
  if (result.status === 200) return result.body as { reference: string };
  handleError(result, "Failed to submit developer support request");
}
