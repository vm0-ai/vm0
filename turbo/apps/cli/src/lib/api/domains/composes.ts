import { initClient } from "@ts-rest/core";
import {
  composesMainContract,
  composesByIdContract,
  composesVersionsContract,
  agentComposeContentSchema,
} from "@vm0/core";
import type { z } from "zod";
import { getClientConfig, handleError } from "../core/client-factory";
import type {
  GetComposeResponse,
  CreateComposeResponse,
  GetComposeVersionResponse,
} from "../core/types";

export async function getComposeByName(
  name: string,
  scope?: string,
): Promise<GetComposeResponse> {
  const config = await getClientConfig();
  const client = initClient(composesMainContract, config);

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
  const client = initClient(composesByIdContract, config);

  const result = await client.getById({
    params: { id },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Compose not found: ${id}`);
}

/**
 * Resolve a version specifier to a full version ID
 * Supports: "latest", full hash (64 chars), or hash prefix (8+ chars)
 */
export async function getComposeVersion(
  composeId: string,
  version: string,
): Promise<GetComposeVersionResponse> {
  const config = await getClientConfig();
  const client = initClient(composesVersionsContract, config);

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
  const client = initClient(composesMainContract, config);

  const result = await client.create({
    body: body as { content: z.infer<typeof agentComposeContentSchema> },
  });

  // Both 200 and 201 are success cases
  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create compose");
}
