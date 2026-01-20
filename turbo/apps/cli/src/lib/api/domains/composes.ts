import {
  composesMainContract,
  composesByIdContract,
  composesVersionsContract,
  agentComposeContentSchema,
} from "@vm0/core";
import type { z } from "zod";
import {
  getClientConfig,
  createClient,
  handleError,
} from "../core/client-factory";
import type {
  GetComposeResponse,
  GetComposeVersionResponse,
  CreateComposeResponse,
} from "../core/types";

export async function getComposeByName(
  name: string,
  scope?: string,
): Promise<GetComposeResponse> {
  const config = await getClientConfig();
  const client = createClient(composesMainContract, config);

  const result = await client.getByName({
    query: { name, scope },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Compose not found: ${name}`);
}

export async function getComposeById(id: string): Promise<GetComposeResponse> {
  const config = await getClientConfig();
  const client = createClient(composesByIdContract, config);

  const result = await client.getById({
    params: { id },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Compose not found: ${id}`);
}

export async function getComposeVersion(
  composeId: string,
  version: string,
): Promise<GetComposeVersionResponse> {
  const config = await getClientConfig();
  const client = createClient(composesVersionsContract, config);

  const result = await client.resolveVersion({
    query: { composeId, version },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Version not found: ${version}`);
}

export async function createOrUpdateCompose(body: {
  content: unknown;
}): Promise<CreateComposeResponse> {
  const config = await getClientConfig();
  const client = createClient(composesMainContract, config);

  const result = await client.create({
    body: body as { content: z.infer<typeof agentComposeContentSchema> },
  });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create compose");
}
