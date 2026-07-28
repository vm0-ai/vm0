import { isIP } from "node:net";

import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  CreateMcpServerBody,
  McpAgentGrant,
  McpServerResponse,
  PatchMcpServerBody,
} from "@vm0/api-contracts/contracts/zero-mcp";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { mcpAgentGrants } from "@vm0/db/schema/mcp-agent-grant";
import { mcpServers } from "@vm0/db/schema/mcp-server";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { fetchHostHasBlockedAddress } from "../../lib/blocked-fetch-host";
import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { safeUrlParse } from "../utils";

type McpServerRow = typeof mcpServers.$inferSelect;

type CreateMcpServerResult =
  | {
      readonly status: "created";
      readonly server: McpServerResponse;
    }
  | { readonly status: "conflict" }
  | {
      readonly status: "invalidEndpoint";
      readonly message: string;
    };

type UpdateMcpServerResult =
  | {
      readonly status: "updated";
      readonly server: McpServerResponse;
    }
  | { readonly status: "notFound" };

type DeleteMcpServerResult =
  | { readonly status: "deleted" }
  | { readonly status: "notFound" };

type ReadMcpAgentGrantsResult =
  | {
      readonly status: "found";
      readonly grants: readonly McpAgentGrant[];
    }
  | { readonly status: "agentNotFound" };

type ReplaceMcpAgentGrantsResult =
  | {
      readonly status: "updated";
      readonly grants: readonly McpAgentGrant[];
    }
  | { readonly status: "agentNotFound" }
  | {
      readonly status: "serversNotFound";
      readonly missingRefs: readonly string[];
    };

type McpEndpointResult =
  | { readonly ok: true; readonly endpoint: string }
  | { readonly ok: false; readonly message: string };

function normalizeMcpHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

function hostnameIsInternal(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    !hostname.includes(".")
  );
}

function normalizeMcpEndpoint(rawEndpoint: string): McpEndpointResult {
  // Registration validates stable syntax only. Every runtime connector must
  // resolve the hostname and reject blocked addresses immediately before use.
  const url = safeUrlParse(rawEndpoint.trim());
  if (!url) {
    return { ok: false, message: "MCP endpoint must be a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "MCP endpoint must use HTTPS" };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      message: "MCP endpoint must not contain embedded credentials",
    };
  }

  const endpointWithoutQueryOrFragment = `${url.origin}${url.pathname}`;
  if (url.href !== endpointWithoutQueryOrFragment) {
    return {
      ok: false,
      message: "MCP endpoint must not contain a query string or fragment",
    };
  }

  const hostname = normalizeMcpHostname(url.hostname);
  const addressFamily = isIP(hostname);
  if (addressFamily === 0) {
    if (hostnameIsInternal(hostname)) {
      return {
        ok: false,
        message: "MCP endpoint must use a public hostname",
      };
    }
  } else if (
    fetchHostHasBlockedAddress([
      { address: hostname, family: addressFamily === 6 ? 6 : 4 },
    ])
  ) {
    return {
      ok: false,
      message: "MCP endpoint must not use a non-public IP address",
    };
  }

  url.hostname = addressFamily === 6 ? `[${hostname}]` : hostname;
  return { ok: true, endpoint: `${url.origin}${url.pathname}` };
}

function mcpServerResponse(row: McpServerRow): McpServerResponse {
  return {
    ref: row.ref,
    displayName: row.displayName,
    endpoint: row.endpoint,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mcpAgentGrantResponse(row: {
  readonly serverRef: string;
  readonly allowAllTools: boolean;
  readonly allowedToolNames: readonly string[];
}): McpAgentGrant {
  return {
    serverRef: row.serverRef,
    toolPolicy: row.allowAllTools
      ? { kind: "all" }
      : { kind: "exact", toolNames: [...row.allowedToolNames] },
  };
}

export async function listMcpServers(
  db: ReadonlyDb,
  orgId: string,
): Promise<readonly McpServerResponse[]> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.orgId, orgId))
    .orderBy(asc(mcpServers.ref));
  return rows.map(mcpServerResponse);
}

export async function createMcpServer(
  db: Db,
  args: {
    readonly orgId: string;
    readonly input: CreateMcpServerBody;
  },
): Promise<CreateMcpServerResult> {
  const endpoint = normalizeMcpEndpoint(args.input.endpoint);
  if (!endpoint.ok) {
    return { status: "invalidEndpoint", message: endpoint.message };
  }

  const [row] = await db
    .insert(mcpServers)
    .values({
      orgId: args.orgId,
      ref: args.input.ref,
      displayName: args.input.displayName,
      endpoint: endpoint.endpoint,
      enabled: args.input.enabled,
    })
    .onConflictDoNothing({
      target: [mcpServers.orgId, mcpServers.ref],
    })
    .returning();

  return row
    ? { status: "created", server: mcpServerResponse(row) }
    : { status: "conflict" };
}

export async function updateMcpServer(
  db: Db,
  args: {
    readonly orgId: string;
    readonly ref: string;
    readonly input: PatchMcpServerBody;
  },
): Promise<UpdateMcpServerResult> {
  const [row] = await db
    .update(mcpServers)
    .set({
      ...(args.input.displayName !== undefined
        ? { displayName: args.input.displayName }
        : {}),
      ...(args.input.enabled !== undefined
        ? { enabled: args.input.enabled }
        : {}),
      updatedAt: nowDate(),
    })
    .where(and(eq(mcpServers.orgId, args.orgId), eq(mcpServers.ref, args.ref)))
    .returning();

  return row
    ? { status: "updated", server: mcpServerResponse(row) }
    : { status: "notFound" };
}

export async function deleteMcpServer(
  db: Db,
  args: {
    readonly orgId: string;
    readonly ref: string;
  },
): Promise<DeleteMcpServerResult> {
  const [deleted] = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.orgId, args.orgId), eq(mcpServers.ref, args.ref)))
    .returning({ id: mcpServers.id });

  return deleted ? { status: "deleted" } : { status: "notFound" };
}

export async function readMcpAgentGrants(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<ReadMcpAgentGrantsResult> {
  const [agent] = await db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, args.orgId),
        eq(zeroAgents.id, args.agentId),
        eq(zeroAgents.owner, args.userId),
      ),
    )
    .limit(1);
  if (!agent) {
    return { status: "agentNotFound" };
  }

  const rows = await db
    .select({
      serverRef: mcpServers.ref,
      allowAllTools: mcpAgentGrants.allowAllTools,
      allowedToolNames: mcpAgentGrants.allowedToolNames,
    })
    .from(mcpAgentGrants)
    .innerJoin(mcpServers, eq(mcpAgentGrants.serverId, mcpServers.id))
    .where(
      and(
        eq(mcpAgentGrants.orgId, args.orgId),
        eq(mcpAgentGrants.userId, args.userId),
        eq(mcpAgentGrants.agentId, args.agentId),
        eq(mcpServers.orgId, args.orgId),
      ),
    )
    .orderBy(asc(mcpServers.ref));

  return {
    status: "found",
    grants: rows.map(mcpAgentGrantResponse),
  };
}

export async function replaceMcpAgentGrants(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly grants: readonly McpAgentGrant[];
  },
): Promise<ReplaceMcpAgentGrantsResult> {
  return await db.transaction(async (tx) => {
    const [compose] = await tx
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, args.orgId),
          eq(agentComposes.id, args.agentId),
        ),
      )
      .for("update")
      .limit(1);
    if (!compose) {
      return { status: "agentNotFound" };
    }

    const [agent] = await tx
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(
        and(
          eq(zeroAgents.orgId, args.orgId),
          eq(zeroAgents.id, args.agentId),
          eq(zeroAgents.owner, args.userId),
        ),
      )
      .for("update")
      .limit(1);
    if (!agent) {
      return { status: "agentNotFound" };
    }

    const requestedRefs = args.grants
      .map((grant) => {
        return grant.serverRef;
      })
      .sort();
    const serverRows =
      requestedRefs.length === 0
        ? []
        : await tx
            .select({ id: mcpServers.id, ref: mcpServers.ref })
            .from(mcpServers)
            .where(
              and(
                eq(mcpServers.orgId, args.orgId),
                inArray(mcpServers.ref, requestedRefs),
              ),
            )
            .orderBy(asc(mcpServers.ref))
            .for("update");
    const serverIds = new Map(
      serverRows.map((server) => {
        return [server.ref, server.id];
      }),
    );
    const missingRefs = requestedRefs.filter((ref) => {
      return !serverIds.has(ref);
    });
    if (missingRefs.length > 0) {
      return { status: "serversNotFound", missingRefs };
    }

    const grantScope = and(
      eq(mcpAgentGrants.orgId, args.orgId),
      eq(mcpAgentGrants.userId, args.userId),
      eq(mcpAgentGrants.agentId, args.agentId),
    );
    await tx.delete(mcpAgentGrants).where(grantScope);

    if (args.grants.length > 0) {
      await tx.insert(mcpAgentGrants).values(
        args.grants.map((grant) => {
          const serverId = serverIds.get(grant.serverRef);
          if (!serverId) {
            throw new Error(
              `Expected locked MCP server for ref: ${grant.serverRef}`,
            );
          }
          return {
            orgId: args.orgId,
            userId: args.userId,
            agentId: args.agentId,
            serverId,
            allowAllTools: grant.toolPolicy.kind === "all",
            allowedToolNames:
              grant.toolPolicy.kind === "exact"
                ? [...grant.toolPolicy.toolNames]
                : [],
          };
        }),
      );
    }

    return {
      status: "updated",
      grants: [...args.grants].sort((left, right) => {
        return left.serverRef.localeCompare(right.serverRef);
      }),
    };
  });
}
