import { initClient } from "@ts-rest/core";
import {
  composesMainContract,
  composesByIdContract,
  composesVersionsContract,
  agentComposeApiContentSchema,
} from "@vm0/core/contracts/composes";
import type { z } from "zod";
import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import type {
  GetComposeResponse,
  CreateComposeResponse,
  GetComposeVersionResponse,
} from "../core/types";

export async function getComposeByName(
  name: string,
): Promise<GetComposeResponse | null> {
  const config = await getClientConfig();
  const client = initClient(composesMainContract, config);

  const result = await client.getByName({
    query: { name },
  });

  if (result.status === 200) {
    return result.body;
  }

  if (result.status === 404) {
    return null;
  }

  handleError(result, `Compose not found: ${name}`);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an agent identifier to a compose.
 * Accepts either a UUID (compose ID) or a human-readable compose name.
 * UUID is tried first; if the identifier is not a UUID, falls back to name lookup.
 */
export async function resolveCompose(
  identifier: string,
): Promise<GetComposeResponse | null> {
  if (UUID_PATTERN.test(identifier)) {
    try {
      return await getComposeById(identifier);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }
  return getComposeByName(identifier);
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
    body: body as { content: z.infer<typeof agentComposeApiContentSchema> },
  });

  // Both 200 and 201 are success cases
  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create compose");
}
