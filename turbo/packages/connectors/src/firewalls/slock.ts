// Hand-authored firewall config for Slock's public control API.
// Move this to the firewalls generator when Slock publishes an API spec.

import type { FirewallConfig } from "../firewall-types";

export const slockFirewall = {
  name: "slock",
  description: "Slock API",
  placeholders: {
    SLOCK_ACCESS_TOKEN: "slock_access_token_placeholder",
    SLOCK_SERVER_ID: "slock_server_id_placeholder",
  },
  apis: [
    {
      base: "https://api.slock.ai",
      auth: {
        headers: {
          Authorization: "Bearer ${{ secrets.SLOCK_ACCESS_TOKEN }}",
          "X-Server-Id": "${{ secrets.SLOCK_SERVER_ID }}",
        },
      },
      permissions: [
        {
          name: "auth:read",
          description: "Read the current Slock user profile",
          rules: ["GET /api/auth/me"],
        },
        {
          name: "servers:read",
          description: "Read Slock server metadata and memberships",
          rules: [
            "GET /api/servers",
            "GET /api/servers/{serverId}",
            "GET /api/servers/{serverId}/members",
          ],
        },
        {
          name: "machines:read",
          description: "Read Slock computer machine state",
          rules: [
            "GET /api/servers/{serverId}/machines",
            "GET /api/servers/{serverId}/machines/{machineId}",
          ],
        },
        {
          name: "machines:write",
          description: "Create, update, delete, and rotate Slock machines",
          rules: [
            "POST /api/servers/{serverId}/machines",
            "PATCH /api/servers/{serverId}/machines/{machineId}",
            "DELETE /api/servers/{serverId}/machines/{machineId}",
            "POST /api/servers/{serverId}/machines/{machineId}/rotate-key",
          ],
        },
        {
          name: "agents:read",
          description: "Read Slock agents",
          rules: ["GET /api/agents", "GET /api/agents/{agentId}"],
        },
        {
          name: "agents:write",
          description: "Create, update, delete, and control Slock agents",
          rules: [
            "POST /api/agents",
            "PATCH /api/agents/{agentId}",
            "DELETE /api/agents/{agentId}",
            "POST /api/agents/{agentId}/start",
            "POST /api/agents/{agentId}/stop",
            "POST /api/agents/{agentId}/reset",
            "POST /api/agents/{agentId}/assign-machine",
          ],
        },
        {
          name: "channels:read",
          description: "Read Slock channels and members",
          rules: [
            "GET /api/channels",
            "GET /api/channels/{channelId}",
            "GET /api/channels/{channelId}/members",
          ],
        },
        {
          name: "channels:write",
          description: "Create and manage Slock channels and memberships",
          rules: [
            "POST /api/channels",
            "POST /api/channels/{channelId}/join",
            "POST /api/channels/{channelId}/leave",
            "POST /api/channels/{channelId}/members",
            "DELETE /api/channels/{channelId}",
          ],
        },
        {
          name: "messages:read",
          description: "Read Slock messages and search results",
          rules: [
            "GET /api/messages/channel/{channelId}",
            "GET /api/messages/context/{messageId}",
            "GET /api/messages/search",
            "GET /api/messages/sync",
          ],
        },
        {
          name: "messages:write",
          description: "Send Slock messages",
          rules: ["POST /api/channels/dm", "POST /api/messages"],
        },
        {
          name: "tasks:read",
          description: "Read Slock channel tasks",
          rules: ["GET /api/tasks/channel/{channelId}"],
        },
        {
          name: "tasks:write",
          description: "Create and update Slock tasks",
          rules: [
            "POST /api/tasks/channel/{channelId}",
            "PATCH /api/tasks/{taskId}/claim",
            "PATCH /api/tasks/{taskId}/unclaim",
            "PATCH /api/tasks/{taskId}/status",
            "DELETE /api/tasks/{taskId}",
            "POST /api/tasks/convert-message",
          ],
        },
        {
          name: "attachments:write",
          description: "Upload Slock attachments",
          rules: ["POST /api/attachments/upload"],
        },
      ],
    },
  ],
} as const satisfies FirewallConfig;
