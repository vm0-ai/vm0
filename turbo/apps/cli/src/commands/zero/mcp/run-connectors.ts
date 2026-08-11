import {
  ZERO_CUSTOM_CONNECTOR_IDS_ENV_KEY,
  type CustomConnectorMcpClientResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { ZeroMcpConnector } from "@vm0/api-contracts/contracts/zero-mcp-connectors";
import { z } from "zod";

import {
  listZeroCustomConnectors,
  listZeroRunMcpConnectors,
} from "../../../lib/api/domains/zero-connectors";

const MAX_RUN_CONNECTOR_IDS_BYTES = 128 * 1024;
const RUN_METADATA_ERROR =
  "MCP connector metadata is unavailable for this run. Start a new Agent Run and try again.";

const runConnectorIdsSchema = z.array(z.uuid());

function readRunConnectorIds(): Set<string> {
  const raw = process.env[ZERO_CUSTOM_CONNECTOR_IDS_ENV_KEY];
  if (
    raw === undefined ||
    Buffer.byteLength(raw, "utf8") > MAX_RUN_CONNECTOR_IDS_BYTES
  ) {
    throw new Error(RUN_METADATA_ERROR);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(RUN_METADATA_ERROR);
  }

  const result = runConnectorIdsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(RUN_METADATA_ERROR);
  }

  const normalizedIds = result.data.map((id) => {
    return id.toLowerCase();
  });
  const uniqueIds = new Set(normalizedIds);
  if (uniqueIds.size !== normalizedIds.length) {
    throw new Error(RUN_METADATA_ERROR);
  }
  return uniqueIds;
}

export async function listRunMcpConnectors(): Promise<ZeroMcpConnector[]> {
  const discoveredConnectors = await listZeroRunMcpConnectors();
  if (discoveredConnectors !== null) {
    return discoveredConnectors;
  }

  // Commit-addressed CLI ↔ backend rollout fallback: a newly selected CLI can
  // reach an API deployment that predates this additive route. Remove with
  // #26389 after its >4-hour queue/run drain and production evidence gate.
  const admittedIds = readRunConnectorIds();
  const connectors = await listZeroCustomConnectors();

  return connectors
    .filter((connector): connector is CustomConnectorMcpClientResponse => {
      return (
        connector.kind === "mcp" && admittedIds.has(connector.id.toLowerCase())
      );
    })
    .sort((left, right) => {
      return left.slug.localeCompare(right.slug);
    });
}

export async function resolveRunMcpConnector(
  connectorSlug: string,
): Promise<ZeroMcpConnector> {
  const connectors = await listRunMcpConnectors();
  const connector = connectors.find((candidate) => {
    return candidate.slug === connectorSlug;
  });
  if (!connector) {
    throw new Error(
      `MCP connector "${connectorSlug}" is not authorized for this Agent`,
    );
  }
  return connector;
}
