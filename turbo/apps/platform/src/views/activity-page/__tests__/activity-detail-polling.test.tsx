import { screen, waitFor } from "@testing-library/react";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import {
  zeroRunAgentEventsContract,
  zeroRunContextContract,
  zeroRunNetworkLogsContract,
  zeroRunRunnerContract,
  type RunContextResponse,
} from "@vm0/api-contracts/contracts/zero-runs";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEvent,
  AgentEventsResponse,
  LogDetail,
} from "../../../signals/zero-page/log-types.ts";
import {
  loadNetworkLogsNextPage$,
  zeroActivityNetworkLogs$,
} from "../../../signals/activity-page/activity-network-signals.ts";
import { fetchDownloadExtra$ } from "../../../signals/activity-page/activity-download.ts";
import {
  detachedNavigateTo$,
  pushPathSilently$,
} from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { resetSignal } from "../../../signals/utils.ts";

const context = testContext();
const LONG_GENERIC_CODEX_OUTPUT = "verbose adapter output ".repeat(20);

function makeLogDetail(overrides: Partial<LogDetail>): LogDetail {
  return {
    id: "a0000000-0000-4000-a000-000000000099",
    sessionId: "session_new",
    agentId: "e0000000-0000-4000-a000-000000000010",
    displayName: "Agent One",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    automationId: null,
    status: "running",
    prompt: "Hello",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: null,
    artifact: { name: null, version: null },
    ...overrides,
  };
}

function detailedActivityEvents(): AgentEvent[] {
  return [
    {
      sequenceNumber: 0,
      eventType: "system",
      eventData: {
        subtype: "init",
        tools: ["Bash", "TodoWrite"],
        agents: ["checkout-auditor"],
        slash_commands: ["review"],
      },
      createdAt: "2026-03-10T14:56:01Z",
    },
    {
      sequenceNumber: 1,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "text",
              text: "I will inspect the checkout failure.",
            },
            {
              type: "tool_use",
              id: "tool-bash-1",
              name: "Bash",
              input: { command: "pnpm test -- --filter checkout" },
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:02Z",
    },
    {
      sequenceNumber: 2,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-bash-1",
              content: "checkout failure reproduced",
              is_error: false,
            },
          ],
        },
        tool_use_result: { durationMs: 1234, bytes: 512 },
      },
      createdAt: "2026-03-10T14:56:03Z",
    },
    {
      sequenceNumber: 3,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-todo-1",
              name: "TodoWrite",
              input: {
                todos: [
                  {
                    content: "Reproduce checkout failure",
                    status: "completed",
                  },
                  { content: "Verify checkout retry", status: "in_progress" },
                ],
              },
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:04Z",
    },
    {
      sequenceNumber: 4,
      eventType: "system",
      eventData: {
        subtype: "task_started",
        task_id: "task-checkout",
        tool_use_id: "task-tool-1",
        description: "Audit checkout logs",
      },
      createdAt: "2026-03-10T14:56:05Z",
    },
    {
      sequenceNumber: 5,
      eventType: "assistant",
      eventData: {
        parent_tool_use_id: "task-tool-1",
        message: {
          content: [
            {
              type: "text",
              text: "The retry path drops the payment intent id.",
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:06Z",
    },
    {
      sequenceNumber: 6,
      eventType: "system",
      eventData: {
        subtype: "task_notification",
        task_id: "task-checkout",
        status: "completed",
        summary: "Audited checkout logs",
      },
      createdAt: "2026-03-10T14:56:07Z",
    },
    {
      sequenceNumber: 7,
      eventType: "result",
      eventData: {
        type: "result",
        is_error: false,
        result: "Checkout investigation complete.",
        num_turns: 3,
        duration_ms: 2000,
        modelUsage: {
          "claude-sonnet-4": {
            inputTokens: 1200,
            outputTokens: 340,
          },
        },
      },
      createdAt: "2026-03-10T14:56:08Z",
    },
  ];
}

function complexGroupedActivityEvents(): AgentEvent[] {
  return [
    {
      sequenceNumber: 0,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "text",
              text: "I will inspect the release automation failure.",
            },
            {
              type: "tool_use",
              id: "tool-read-config",
              name: "Read",
              input: { file_path: "src/release/config.ts" },
            },
            {
              type: "tool_use",
              id: "tool-read-runner",
              name: "Read",
              input: { file_path: "src/release/runner.ts" },
            },
          ],
        },
      },
      createdAt: "2026-03-10T16:00:01Z",
    },
    {
      sequenceNumber: 1,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-read-config",
              content: "export const releaseConfig = true;",
              is_error: false,
            },
          ],
        },
        tool_use_result: { durationMs: 45, bytes: 512 },
      },
      createdAt: "2026-03-10T16:00:02Z",
    },
    {
      sequenceNumber: 2,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-read-runner",
              content:
                "line 1\nline 2\nline 3\nline 4\nrelease runner timed out",
              is_error: false,
            },
          ],
        },
        tool_use_result: { durationMs: 1234, bytes: 2048 },
      },
      createdAt: "2026-03-10T16:00:03Z",
    },
    {
      sequenceNumber: 3,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-write-empty",
              name: "Write",
              input: {
                file_path: "src/release/notes.md",
                content: "Release notes placeholder",
              },
            },
            {
              type: "tool_use",
              id: "tool-skill-fail",
              name: "Skill",
              input: {
                skill: "release-auditor",
                args: "dry-run",
              },
            },
            {
              type: "tool_use",
              id: "tool-edit-deploy",
              name: "Edit",
              input: {
                file_path: "src/release/deploy.ts",
                old_string: "const deployToken = process.env.OLD_TOKEN;",
                new_string: "const deployToken = process.env.DEPLOY_TOKEN;",
              },
            },
            {
              type: "tool_use",
              id: "tool-api-call",
              name: "ApiCall",
              input: {
                endpoint: "/v1/deployments",
                retries: 2,
                payload:
                  "release-payload-with-a-long-trace-id-that-should-truncate",
              },
            },
          ],
        },
      },
      createdAt: "2026-03-10T16:00:04Z",
    },
    {
      sequenceNumber: 4,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-write-empty",
              content: "",
              is_error: false,
            },
          ],
        },
        tool_use_result: { durationMs: 20 },
      },
      createdAt: "2026-03-10T16:00:05Z",
    },
    {
      sequenceNumber: 5,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-skill-fail",
              content: "release-auditor failed\nmissing deploy token",
              is_error: true,
            },
          ],
        },
        tool_use_result: { durationMs: 2345 },
      },
      createdAt: "2026-03-10T16:00:06Z",
    },
    {
      sequenceNumber: 6,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-edit-deploy",
              content: "Patched deploy token lookup.",
              is_error: false,
            },
          ],
        },
        tool_use_result: { durationMs: 88 },
      },
      createdAt: "2026-03-10T16:00:07Z",
    },
    {
      sequenceNumber: 7,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-api-call",
              content: "deployment accepted",
              is_error: false,
            },
          ],
        },
        tool_use_result: { durationMs: 99 },
      },
      createdAt: "2026-03-10T16:00:08Z",
    },
    {
      sequenceNumber: 8,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "orphan-tool",
              content: "orphan cleanup result",
              is_error: false,
            },
          ],
        },
        tool_use_result: { durationMs: 77 },
      },
      createdAt: "2026-03-10T16:00:09Z",
    },
    {
      sequenceNumber: 9,
      eventType: "system",
      eventData: {
        subtype: "task_started",
        task_id: "release-task",
        description: "Run release validation",
      },
      createdAt: "2026-03-10T16:00:10Z",
    },
    {
      sequenceNumber: 10,
      eventType: "system",
      eventData: {
        subtype: "task_progress",
        task_id: "release-task",
        summary: "Still checking release validation",
      },
      createdAt: "2026-03-10T16:00:11Z",
    },
    {
      sequenceNumber: 11,
      eventType: "system",
      eventData: {
        subtype: "task_notification",
        task_id: "release-task",
        status: "failed",
        summary: "Release validation failed",
      },
      createdAt: "2026-03-10T16:00:12Z",
    },
    {
      sequenceNumber: 12,
      eventType: "result",
      eventData: {
        type: "result",
        is_error: true,
        result: "Release automation still needs a deploy token.",
        num_turns: 2,
        duration_ms: 4000,
      },
      createdAt: "2026-03-10T16:00:13Z",
    },
  ];
}

function edgeGroupedActivityEvents(): AgentEvent[] {
  return [
    {
      sequenceNumber: 0,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-web-fetch",
              name: "WebFetch",
              input: { url: "https://docs.example.test/runbook" },
            },
          ],
        },
      },
      createdAt: "2026-03-10T17:00:01Z",
    },
    {
      sequenceNumber: 1,
      eventType: "user",
      eventData: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-web-fetch",
              content: "Runbook section loaded",
              is_error: false,
            },
          ],
        },
      },
      createdAt: "2026-03-10T17:00:02Z",
    },
    {
      sequenceNumber: 2,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-web-search",
              name: "WebSearch",
              input: { query: "release rollback status page" },
            },
          ],
        },
      },
      createdAt: "2026-03-10T17:00:03Z",
    },
    {
      sequenceNumber: 3,
      eventType: "system",
      eventData: {
        subtype: "task_notification",
        task_id: "orphan-release-task",
        description: "Orphan release notification",
        status: "completed",
        summary: "Orphan release notification",
      },
      createdAt: "2026-03-10T17:00:04Z",
    },
    {
      sequenceNumber: 4,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-task-prompt",
              name: "Task",
              input: {
                prompt:
                  "Ask release assistant to verify the deployment rollback checklist before continuing",
              },
            },
            {
              type: "tool_use",
              id: "tool-custom-prompt",
              name: "CustomTool",
              input: {
                prompt:
                  "Collect incident channel status and deployment owner notes",
              },
            },
          ],
        },
      },
      createdAt: "2026-03-10T17:00:05Z",
    },
    {
      sequenceNumber: 5,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-empty-todos",
              name: "TodoWrite",
              input: { todos: "not an array" },
            },
          ],
        },
      },
      createdAt: "2026-03-10T17:00:06Z",
    },
    {
      sequenceNumber: 6,
      eventType: "system",
      eventData: {
        subtype: "task_started",
        task_id: "child-release-task",
        tool_use_id: "tool-child-task",
        description: "Inspect release child task",
      },
      createdAt: "2026-03-10T17:00:07Z",
    },
    {
      sequenceNumber: 7,
      eventType: "user",
      eventData: {
        parent_tool_use_id: "tool-child-task",
        message: {
          content: [
            {
              type: "tool_result",
              content: "child orphan cleanup result",
              is_error: false,
            },
          ],
        },
      },
      createdAt: "2026-03-10T17:00:08Z",
    },
    {
      sequenceNumber: 8,
      eventType: "assistant",
      eventData: {
        parent_tool_use_id: "tool-child-task",
        message: {
          content: [
            {
              type: "text",
              text: "Child task found one risky deployment.",
            },
          ],
        },
      },
      createdAt: "2026-03-10T17:00:09Z",
    },
    {
      sequenceNumber: 9,
      eventType: "assistant",
      eventData: {
        parent_tool_use_id: "tool-child-task",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-child-bash",
              name: "Bash",
              input: { command: "zero deploy status --json" },
            },
          ],
        },
      },
      createdAt: "2026-03-10T17:00:10Z",
    },
    {
      sequenceNumber: 10,
      eventType: "user",
      eventData: {
        parent_tool_use_id: "tool-child-task",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-child-bash",
              content: "rollback is ready",
              is_error: false,
            },
          ],
        },
      },
      createdAt: "2026-03-10T17:00:11Z",
    },
    {
      sequenceNumber: 11,
      eventType: "result",
      eventData: {
        type: "result",
        is_error: false,
        result: "Release edge inspection complete.",
        num_turns: 1,
        duration_ms: 1000,
      },
      createdAt: "2026-03-10T17:00:12Z",
    },
  ];
}

function checkoutNetworkLogs(): NetworkLogEntry[] {
  return [
    {
      timestamp: "2026-03-10T14:56:03.000Z",
      type: "http",
      action: "ALLOW",
      method: "POST",
      url: "https://payments.example.test/v1/checkout",
      status: 200,
      latency_ms: 245,
      request_size: 128,
      response_size: 512,
      firewall_name: "payments",
      firewall_permission: "checkout-write",
      firewall_rule_match: "POST /v1/checkout",
      firewall_params: { tenant: "acme" },
      firewall_billable: true,
      auth_resolved_secrets: ["PAYMENTS_API_KEY"],
      browser_user_agent: false,
      request_headers: {
        authorization: "Bearer sk_test",
        "content-type": "application/json",
      },
      request_body: '{"cartId":"cart_123","retry":true}',
      response_headers: {
        "content-type": "application/json",
      },
      response_body: "eyJzdGF0dXMiOiJvayJ9",
      response_body_encoding: "base64",
      response_body_truncated: true,
    },
  ];
}

function mixedNetworkLogs(): NetworkLogEntry[] {
  return [
    {
      timestamp: "2026-03-10T14:56:11.000Z",
      type: "dns",
      action: "ALLOW",
      host: "api.service.test",
      latency_ms: 12,
      dns_event: "query",
      dns_query_type: "AAAA",
      dns_result: "2001:db8::1",
      dns_serial: "dns-99",
    },
    {
      timestamp: "2026-03-10T14:56:11.500Z",
      type: "http",
      action: "BLOCK",
      host: "blocked.service.test",
      port: 443,
      method: "POST",
      url: "",
      status: 424,
      latency_ms: 4,
      request_size: 0,
      response_size: 128,
      firewall_name: "blocked-service",
      firewall_error: "connector_not_configured",
    },
    {
      timestamp: "2026-03-10T14:56:12.000Z",
      type: "tcp",
      action: "DENY",
      host: "db.internal",
      port: 5432,
      latency_ms: 2300,
      firewall_name: "database",
      firewall_permission: "postgres",
      firewall_error: "database blocked",
      error: "connect ECONNREFUSED",
    },
    {
      timestamp: "2026-03-10T14:56:13.000Z",
      type: "udp",
      action: "ALLOW",
      host: "resolver.internal",
      port: 53,
      firewall_name: "dns-egress",
      firewall_permission: "dns",
      firewall_rule_match: "udp/53",
      firewall_base: "resolver.internal",
      firewall_params: { region: "iad", profile: "primary" },
      firewall_billable: false,
      auth_refreshed_connectors: ["google-drive", "slack"],
      auth_refreshed_secrets: ["DNS_TOKEN"],
      auth_cache_hit: false,
      auth_url_rewrite: true,
    },
    {
      timestamp: "2026-03-10T14:56:14.000Z",
      type: "icmp",
      action: "ALLOW",
      host: "edge.gateway",
      latency_ms: 2100,
    },
    {
      timestamp: "2026-03-10T14:56:15.000Z",
      type: "unix",
      action: "ALLOW",
      host: "local.socket",
      port: 0,
    },
  ];
}

function codexActivityEvents(): AgentEvent[] {
  return [
    {
      sequenceNumber: 0,
      eventType: "thread.started",
      eventData: {
        type: "thread.started",
        thread_id: "codex-thread-1",
      },
      createdAt: "2026-03-10T15:00:01Z",
    },
    {
      sequenceNumber: 1,
      eventType: "turn.started",
      eventData: { type: "turn.started" },
      createdAt: "2026-03-10T15:00:02Z",
    },
    {
      sequenceNumber: 2,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "msg-1",
          type: "agent_message",
          text: "I checked the billing worker retry path.",
        },
      },
      createdAt: "2026-03-10T15:00:03Z",
    },
    {
      sequenceNumber: 3,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          text: "Follow the failed retry through the logs.",
        },
      },
      createdAt: "2026-03-10T15:00:04Z",
    },
    {
      sequenceNumber: 4,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "pnpm test --filter billing-worker",
        },
      },
      createdAt: "2026-03-10T15:00:05Z",
    },
    {
      sequenceNumber: 5,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          exit_code: 1,
          aggregated_output:
            "billing worker failed\nstack line 1\nstack line 2\nstack line 3\nstack line 4",
        },
      },
      createdAt: "2026-03-10T15:00:06Z",
    },
    {
      sequenceNumber: 6,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: {
          id: "read-1",
          type: "file_read",
          path: "src/billing/worker.ts",
        },
      },
      createdAt: "2026-03-10T15:00:07Z",
    },
    {
      sequenceNumber: 7,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "read-1",
          type: "file_read",
          output: "export const worker = true;",
        },
      },
      createdAt: "2026-03-10T15:00:08Z",
    },
    {
      sequenceNumber: 8,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: {
          id: "edit-1",
          type: "file_edit",
          path: "src/billing/worker.ts",
        },
      },
      createdAt: "2026-03-10T15:00:09Z",
    },
    {
      sequenceNumber: 9,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "edit-1",
          type: "file_edit",
          diff: "- old retry\n+ new retry",
        },
      },
      createdAt: "2026-03-10T15:00:10Z",
    },
    {
      sequenceNumber: 10,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "files-1",
          type: "file_change",
          changes: [
            { kind: "modify", path: "src/billing/worker.ts" },
            { kind: "add", path: "src/billing/retry.test.ts" },
          ],
        },
      },
      createdAt: "2026-03-10T15:00:11Z",
    },
    {
      sequenceNumber: 11,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "unknown-1",
          type: "unknown_item",
          status: "completed",
          title: "Unknown codex item surfaced",
        },
      },
      createdAt: "2026-03-10T15:00:12Z",
    },
    {
      sequenceNumber: 12,
      eventType: "turn.completed",
      eventData: {
        type: "turn.completed",
        usage: {
          input_tokens: 111,
          cached_input_tokens: 22,
          output_tokens: 33,
          reasoning_output_tokens: 4,
        },
      },
      createdAt: "2026-03-10T15:00:13Z",
    },
  ];
}

function codexFallbackActivityEvents(): AgentEvent[] {
  return [
    {
      sequenceNumber: 0,
      eventType: "item.completed",
      eventData: { type: "item.completed" },
      createdAt: "2026-03-10T15:30:01Z",
    },
    {
      sequenceNumber: 1,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "agent-message-empty",
          type: "agent_message",
          status: "completed",
        },
      },
      createdAt: "2026-03-10T15:30:02Z",
    },
    {
      sequenceNumber: 2,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "files-empty",
          type: "file_change",
          changes: [],
        },
      },
      createdAt: "2026-03-10T15:30:03Z",
    },
    {
      sequenceNumber: 3,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: {
          id: "write-fallback",
          type: "file_write",
          file_path: "src/generated.ts",
        },
      },
      createdAt: "2026-03-10T15:30:04Z",
    },
    {
      sequenceNumber: 4,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "write-fallback",
          type: "file_write",
        },
      },
      createdAt: "2026-03-10T15:30:05Z",
    },
    {
      sequenceNumber: 5,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        item: {
          id: "read-fallback",
          type: "file_read",
          filePath: "src/edge.ts",
        },
      },
      createdAt: "2026-03-10T15:30:06Z",
    },
    {
      sequenceNumber: 6,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "read-fallback",
          type: "file_read",
        },
      },
      createdAt: "2026-03-10T15:30:07Z",
    },
    {
      sequenceNumber: 7,
      eventType: "turn.failed",
      eventData: {
        type: "turn.failed",
        error: "Codex build failed before retry.",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
        },
      },
      createdAt: "2026-03-10T15:30:08Z",
    },
    {
      sequenceNumber: 8,
      eventType: "error",
      eventData: {
        type: "error",
        message: "Codex stream disconnected.",
      },
      createdAt: "2026-03-10T15:30:09Z",
    },
    {
      sequenceNumber: 9,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "files-malformed",
          type: "file_change",
          changes: [
            ...Array.from({ length: 20 }, () => {
              return {};
            }),
            { kind: "modify", filePath: "src/late-valid.ts" },
          ],
        },
      },
      createdAt: "2026-03-10T15:30:10Z",
    },
  ];
}

function codexAdapterActivityEvents(): AgentEvent[] {
  return [
    {
      sequenceNumber: 0,
      eventType: "thread.started",
      eventData: {
        type: "thread.started",
        thread_id: "codex-thread-adapter",
      },
      createdAt: "2026-03-10T16:00:01Z",
    },
    {
      sequenceNumber: 1,
      eventType: "warning",
      eventData: {
        type: "warning",
        thread_id: "codex-thread-adapter",
        message: "Retryable adapter warning",
      },
      createdAt: "2026-03-10T16:00:02Z",
    },
    {
      sequenceNumber: 2,
      eventType: "turn.plan.updated",
      eventData: {
        type: "turn.plan.updated",
        thread_id: "codex-thread-adapter",
        turn_id: "turn-plan",
        explanation: "Refresh adapter event plan",
        plan: [
          ...Array.from({ length: 20 }, () => {
            return {};
          }),
          { step: "Collect app-server events", status: "completed" },
          { step: "Normalize Platform rows", status: "in_progress" },
        ],
      },
      createdAt: "2026-03-10T16:00:03Z",
    },
    {
      sequenceNumber: 3,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "turn-plan",
        item: {
          id: "plan-item",
          type: "plan",
          status: "completed",
          text: "Ship Platform normalizer coverage.",
        },
      },
      createdAt: "2026-03-10T16:00:04Z",
    },
    {
      sequenceNumber: 4,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "turn-1",
        item: {
          id: "msg-before-result",
          type: "agent_message",
          status: "completed",
          text: "Visible Codex assistant text before failed summary.",
        },
      },
      createdAt: "2026-03-10T16:00:05Z",
    },
    {
      sequenceNumber: 5,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        turn_id: "turn-1",
        item: {
          id: "cmd-failed",
          type: "command_execution",
          status: "in_progress",
          command: "pnpm test adapter",
        },
      },
      createdAt: "2026-03-10T16:00:06Z",
    },
    {
      sequenceNumber: 6,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "turn-1",
        item: {
          id: "cmd-failed",
          type: "command_execution",
          status: "failed",
          command: "pnpm test adapter",
          aggregated_output: "  partial adapter output\nadapter output tail  ",
          error: {
            message: "Command refused by policy",
            additional_details: "no shell grant",
          },
        },
      },
      createdAt: "2026-03-10T16:00:07Z",
    },
    {
      sequenceNumber: 7,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        turn_id: "turn-1",
        item: {
          id: "read-declined",
          type: "file_read",
          status: "in_progress",
          path: "src/secret.ts",
        },
      },
      createdAt: "2026-03-10T16:00:08Z",
    },
    {
      sequenceNumber: 8,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "turn-1",
        item: {
          id: "read-declined",
          type: "file_read",
          status: "declined",
          error: { message: "Read declined by sandbox" },
        },
      },
      createdAt: "2026-03-10T16:00:09Z",
    },
    {
      sequenceNumber: 9,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "turn-1",
        item: {
          id: "files-failed",
          type: "file_change",
          status: "failed",
          error: { message: "Patch failed before write" },
          changes: [{ kind: "modify", path: "src/adapter.ts" }],
        },
      },
      createdAt: "2026-03-10T16:00:10Z",
    },
    {
      sequenceNumber: 10,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "turn-1",
        item: {
          id: "unknown-object",
          type: "serverOperation",
          status: "completed",
          server: "codex-app-server",
          details: { nested: "bounded detail" },
          aggregatedOutput: LONG_GENERIC_CODEX_OUTPUT,
        },
      },
      createdAt: "2026-03-10T16:00:11Z",
    },
    {
      sequenceNumber: 11,
      eventType: "item.started",
      eventData: {
        type: "item.started",
        turn_id: "turn-1",
        item: {
          id: "cmd-camel-exit",
          type: "command_execution",
          command: "node scripts/fail-with-camel-exit.js",
        },
      },
      createdAt: "2026-03-10T16:00:12Z",
    },
    {
      sequenceNumber: 12,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "turn-1",
        item: {
          id: "cmd-camel-exit",
          type: "command_execution",
          exitCode: 7,
          output: "camel exit failure",
        },
      },
      createdAt: "2026-03-10T16:00:13Z",
    },
    {
      sequenceNumber: 13,
      eventType: "error",
      eventData: {
        type: "error",
        thread_id: "codex-thread-adapter",
        turn_id: "turn-1",
        message: "Adapter transport failed",
        error: {
          message: "Adapter transport failed",
          additional_details: "socket closed",
        },
      },
      createdAt: "2026-03-10T16:00:14Z",
    },
    {
      sequenceNumber: 14,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "turn-1",
        item: {
          id: "msg-after-error",
          type: "agent_message",
          status: "completed",
          text: "Visible Codex assistant text after top-level error.",
        },
      },
      createdAt: "2026-03-10T16:00:15Z",
    },
    {
      sequenceNumber: 15,
      eventType: "turn.completed",
      eventData: {
        type: "turn.completed",
        thread_id: "codex-thread-adapter",
        turn: {
          id: "turn-1",
          status: "failed",
          duration_ms: 2345,
          error: {
            message: "Turn failed",
            additional_details: "model stopped",
          },
        },
        usage: {
          input_tokens: 123,
          output_tokens: 45,
        },
      },
      createdAt: "2026-03-10T16:00:16Z",
    },
    {
      sequenceNumber: 16,
      eventType: "error",
      eventData: {
        type: "error",
        thread_id: "codex-thread-adapter",
        turn_id: "turn-2",
        message: "Different turn top-level failure",
      },
      createdAt: "2026-03-10T16:00:17Z",
    },
    {
      sequenceNumber: 17,
      eventType: "turn.completed",
      eventData: {
        type: "turn.completed",
        thread_id: "codex-thread-adapter",
        turn: {
          id: "turn-3",
          status: "interrupted",
          error: {
            message: "Different turn interrupted",
            codex_error_info: "user interrupt",
          },
        },
      },
      createdAt: "2026-03-10T16:00:18Z",
    },
    {
      sequenceNumber: 18,
      eventType: "error",
      eventData: {
        type: "error",
        thread_id: "codex-thread-adapter",
        turn_id: "turn-4",
        message: "Recoverable adapter error",
      },
      createdAt: "2026-03-10T16:00:19Z",
    },
    {
      sequenceNumber: 19,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "turn-4",
        item: {
          id: "msg-after-recoverable-error",
          type: "agent_message",
          status: "completed",
          text: "Visible Codex assistant text after recoverable error.",
        },
      },
      createdAt: "2026-03-10T16:00:20Z",
    },
    {
      sequenceNumber: 20,
      eventType: "turn.completed",
      eventData: {
        type: "turn.completed",
        thread_id: "codex-thread-adapter",
        turn: {
          id: "turn-4",
          status: "completed",
          duration_ms: 9876,
        },
        usage: {
          input_tokens: 12,
          output_tokens: 3,
        },
      },
      createdAt: "2026-03-10T16:00:21Z",
    },
    {
      sequenceNumber: 21,
      eventType: "turn.completed",
      eventData: {
        type: "turn.completed",
        thread_id: "codex-thread-adapter",
        message: "Turn failed",
        turn: {
          id: "turn-deep-error",
          status: "failed",
          error: {
            error: {
              error: {
                error: {
                  error: {
                    error: {
                      message: "Deep nested adapter failure",
                    },
                  },
                },
              },
            },
          },
        },
      },
      createdAt: "2026-03-10T16:00:22Z",
    },
    {
      sequenceNumber: 22,
      eventType: "turn.completed",
      eventData: {
        type: "turn.completed",
        thread_id: "codex-thread-adapter",
        turn: {
          id: "turn-success-false",
          success: false,
        },
      },
      createdAt: "2026-03-10T16:00:23Z",
    },
  ];
}

function codexRunContext(runId: string): RunContextResponse {
  return {
    prompt: "Repair the billing worker retry path",
    appendSystemPrompt: "Use Codex event logs when available",
    runId,
    sessionId: "codex-thread-1",
    secretNames: ["OPENAI_API_KEY"],
    vars: { CODEX_RETRY: "enabled" },
    environment: { NODE_ENV: "test" },
    firewalls: [
      {
        name: "openai",
        apis: [
          {
            base: "https://api.openai.test",
            permissions: [
              {
                name: "responses-write",
                description: "Create responses",
                rules: ["POST /v1/responses"],
              },
            ],
          },
        ],
      },
    ],
    networkPolicies: {
      openai: {
        allow: ["responses-write"],
        deny: ["metadata-access"],
        ask: [],
        unknownPolicy: "deny",
      },
    },
    volumes: [
      {
        name: "workspace",
        mountPath: "/workspace",
        vasStorageName: "codex-workspace-storage",
        vasVersionId: "workspace-version-1",
      },
    ],
    artifact: {
      mountPath: "/artifact",
      vasStorageName: "codex-artifact-storage",
      vasVersionId: "artifact-version-1",
    },
    featureFlags: { zeroDebug: true, codex: true },
  };
}

function codexNetworkFirstPage(): NetworkLogEntry[] {
  return [
    {
      timestamp: "2026-03-10T15:00:14.000Z",
      type: "http",
      action: "ALLOW",
      method: "POST",
      url: "https://api.openai.test/v1/responses",
      status: 200,
      latency_ms: 320,
      request_size: 256,
      response_size: 1024,
      firewall_name: "openai",
      firewall_permission: "responses-write",
      firewall_rule_match: "POST /v1/responses",
      firewall_params: { model: "codex-mini" },
      firewall_billable: true,
      auth_resolved_secrets: ["OPENAI_API_KEY"],
    },
    {
      timestamp: "2026-03-10T15:00:15.000Z",
      type: "dns",
      action: "ALLOW",
      host: "api.openai.test",
      latency_ms: 5,
      dns_event: "query",
      dns_query_type: "A",
      dns_result: "203.0.113.10",
      dns_serial: "dns-1",
    },
  ];
}

function codexNetworkSecondPage(): NetworkLogEntry[] {
  return [
    {
      timestamp: "2026-03-10T15:00:16.000Z",
      type: "http",
      action: "DENY",
      method: "GET",
      url: "http://metadata.google.internal/latest/meta-data",
      status: 403,
      latency_ms: 1000,
      firewall_error: "metadata access blocked",
    },
  ];
}

function getTabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!tab) {
    throw new Error(`Could not find tab: ${text}`);
  }
  return tab;
}

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Could not find button: ${text}`);
  }
  return button;
}

function getMenuItemCheckboxByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitemcheckbox").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!item) {
    throw new Error(`Could not find menu item checkbox: ${text}`);
  }
  return item;
}

describe("activity detail polling", () => {
  it("shows recovery guidance for a failed activity", async () => {
    const runId = "a0000000-0000-4000-a000-000000000098";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Model Setup Run",
          status: "failed",
          error: "No model provider configured for this workspace",
          completedAt: "2026-03-10T14:56:03Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Model Setup Run" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(
      screen.getByText("No model provider configured"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Configure a model provider to start running agents."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("$ zero model-provider set --help"),
    ).toBeInTheDocument();
  });

  it("renders events that arrive after an initially empty activity history", async () => {
    let eventsAvailable = false;
    let status: LogDetail["status"] = "running";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status }));
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        if (!eventsAvailable) {
          return respond(200, {
            events: [],
            hasMore: false,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        }

        return respond(200, {
          events: [
            {
              sequenceNumber: 0,
              eventType: "assistant",
              eventData: {
                message: {
                  content: [{ type: "text", text: "Polled response arrived" }],
                },
              },
              createdAt: "2026-03-10T14:56:05Z",
            },
          ],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Agent One" }),
      ).toBeInTheDocument();
    });

    const topic = "run:changed:a0000000-0000-4000-a000-000000000099";
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });

    status = "completed";
    eventsAvailable = true;
    context.mocks.ably.trigger(topic);

    await waitFor(() => {
      expect(screen.getByText("Polled response arrived")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });

  it("shows grouped steps search results and network logs for a completed activity", async () => {
    const runId = "a0000000-0000-4000-a000-000000000199";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Checkout Run",
          status: "completed",
          prompt: "Investigate checkout retries",
          appendSystemPrompt: "Use checkout specific diagnostics",
          startedAt: "2026-03-10T14:56:01Z",
          completedAt: "2026-03-10T14:56:10Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: detailedActivityEvents(),
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      ({ respond }) => {
        return respond(200, {
          networkLogs: checkoutNetworkLogs(),
          hasMore: false,
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Checkout Run" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("9.0s")).toBeInTheDocument();
    expect(
      screen.getAllByText("Use checkout specific diagnostics"),
    ).not.toHaveLength(0);
    expect(
      screen.getAllByText("Investigate checkout retries"),
    ).not.toHaveLength(0);
    expect(screen.getByText("Initialize")).toBeInTheDocument();
    expect(screen.getByText("2 tools")).toBeInTheDocument();
    expect(screen.getByText("1 agents")).toBeInTheDocument();
    expect(screen.getByText("1 commands")).toBeInTheDocument();
    expect(
      screen.getByText("I will inspect the checkout failure."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Bash")).not.toHaveLength(0);
    expect(
      screen.getAllByText("pnpm test -- --filter checkout"),
    ).not.toHaveLength(0);
    expect(screen.getAllByText("Verify checkout retry")).not.toHaveLength(0);
    expect(screen.getByText("[1/2]")).toBeInTheDocument();
    expect(screen.getByText("Audit checkout logs")).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(
      screen.getByText("Checkout investigation complete."),
    ).toBeInTheDocument();
    expect(screen.getByText("3 turns")).toBeInTheDocument();

    await fill(screen.getByPlaceholderText("Search steps"), "reproduced");

    await waitFor(() => {
      expect(
        screen.getByText(/\([0-9]+\/[0-9]+ matched\)/u),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText((_, element) => {
          return element?.textContent === "checkout failure reproduced";
        }),
      ).not.toHaveLength(0);
    });

    click(screen.getByText("Network"));

    await waitFor(() => {
      expect(
        screen.getByText("https://payments.example.test/v1/checkout"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("245ms")).toBeInTheDocument();
    expect(screen.getByText("payments")).toBeInTheDocument();

    click(screen.getByText("https://payments.example.test/v1/checkout"));

    await waitFor(() => {
      expect(screen.getByText("Rule Match")).toBeInTheDocument();
      expect(screen.getByText("POST /v1/checkout")).toBeInTheDocument();
      expect(screen.getByText("PAYMENTS_API_KEY")).toBeInTheDocument();
      expect(screen.getByText("Request Headers (2)")).toBeInTheDocument();
      expect(screen.getByText("Request Body")).toBeInTheDocument();
      expect(screen.getByText("Response Body")).toBeInTheDocument();
    });
    expect(
      screen.getByText('{"cartId":"cart_123","retry":true}'),
    ).toBeInTheDocument();
    expect(
      screen.getByText("[Binary data, 15B base64-encoded]"),
    ).toBeInTheDocument();
    expect(screen.getByText("truncated")).toBeInTheDocument();
  });

  it("shows collapsed repeated tools and failed task output", async () => {
    const runId = "a0000000-0000-4000-a000-000000000499";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Release Automation Run",
          status: "failed",
          prompt: "Debug release automation",
          error: "missing deploy token",
          startedAt: "2026-03-10T16:00:01Z",
          completedAt: "2026-03-10T16:00:11Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: complexGroupedActivityEvents(),
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Release Automation Run" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("missing deploy token")).toBeInTheDocument();
    expect(
      screen.getByText("I will inspect the release automation failure."),
    ).toBeInTheDocument();
    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText("src/release/config.ts")).toBeInTheDocument();
    expect(
      screen.getByText("export const releaseConfig = true;"),
    ).toBeInTheDocument();
    click(screen.getByText("+2 lines (2.0 KB)"));
    expect(screen.getByText(/release runner timed out/u)).toBeInTheDocument();
    expect(screen.getByText("Release notes placeholder")).toBeInTheDocument();
    expect(screen.getByText("(empty output)")).toBeInTheDocument();
    expect(screen.getAllByText("release-auditor")).not.toHaveLength(0);
    expect(screen.getAllByText("dry-run")).not.toHaveLength(0);
    expect(screen.getAllByText("release-auditor failed")).not.toHaveLength(0);
    expect(
      screen.getByText("const deployToken = process.env.OLD_TOKEN;"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("const deployToken = process.env.DEPLOY_TOKEN;"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/endpoint: \/v1\/deployments/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/retries: 2/u)).toBeInTheDocument();
    expect(screen.getByText("deployment accepted")).toBeInTheDocument();
    expect(screen.getByText("orphan cleanup result")).toBeInTheDocument();
    expect(screen.getByText("Run release validation")).toBeInTheDocument();
    expect(
      screen.queryByText("Still checking release validation"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Release automation still needs a deploy token."),
    ).toBeInTheDocument();
  });

  it("shows edge-shaped grouped steps", async () => {
    const runId = "a0000000-0000-4000-a000-000000000501";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Release Edge Run",
          status: "completed",
          prompt: "Inspect release edge cases",
          startedAt: "2026-03-10T17:00:01Z",
          completedAt: "2026-03-10T17:00:12Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: edgeGroupedActivityEvents(),
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Release Edge Run" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("https://docs.example.test/runbook"),
    ).toBeInTheDocument();
    expect(screen.getByText("Runbook section loaded")).toBeInTheDocument();
    expect(
      screen.getByText("release rollback status page"),
    ).toBeInTheDocument();
    expect(screen.getByText("Orphan release notification")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Ask release assistant to verify the deployment/u),
    ).not.toHaveLength(0);
    expect(
      screen.getByText(
        "Collect incident channel status and deployment owner notes",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Inspect release child task")).toBeInTheDocument();
    expect(
      screen.getByText("Child task found one risky deployment."),
    ).toBeInTheDocument();
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(screen.getByText("child orphan cleanup result")).toBeInTheDocument();
    expect(screen.getAllByText("zero deploy status --json")).not.toHaveLength(
      0,
    );
    expect(screen.getByText("rollback is ready")).toBeInTheDocument();
    expect(
      screen.getByText("Release edge inspection complete."),
    ).toBeInTheDocument();
  });

  it("filters network logs by type and expands non-HTTP details", async () => {
    const runId = "a0000000-0000-4000-a000-000000000299";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Network Policy Run",
          status: "completed",
          completedAt: "2026-03-10T14:56:13Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      ({ respond }) => {
        return respond(200, {
          networkLogs: mixedNetworkLogs(),
          hasMore: false,
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Network Policy Run" }),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Network"));

    await waitFor(() => {
      expect(screen.getByText("BLOCK")).toBeInTheDocument();
      expect(screen.getByText("blocked.service.test:443")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Type filter"));
    await waitFor(() => {
      expect(getMenuItemCheckboxByText("All types")).toBeInTheDocument();
    });
    click(getMenuItemCheckboxByText("All types"));

    await waitFor(() => {
      expect(screen.getByText("api.service.test:0")).toBeInTheDocument();
      expect(screen.getByText("db.internal:5432")).toBeInTheDocument();
      expect(screen.getByText("resolver.internal:53")).toBeInTheDocument();
      expect(screen.getByText("edge.gateway:0")).toBeInTheDocument();
      expect(screen.getByText("local.socket:0")).toBeInTheDocument();
    });
    expect(screen.getByText("blocked-service")).toBeInTheDocument();
    expect(screen.getAllByText("DNS").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TCP").length).toBeGreaterThan(0);
    expect(screen.getAllByText("UDP").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ICMP").length).toBeGreaterThan(0);
    expect(screen.getAllByText("UNIX").length).toBeGreaterThan(0);

    click(screen.getByText("api.service.test:0"));

    await waitFor(() => {
      expect(screen.getByText("DNS Event")).toBeInTheDocument();
      expect(screen.getByText("AAAA")).toBeInTheDocument();
      expect(screen.getByText("dns-99")).toBeInTheDocument();
    });

    click(screen.getByText("db.internal:5432"));

    await waitFor(() => {
      expect(screen.getByText("Permission Error")).toBeInTheDocument();
      expect(screen.getByText("database blocked")).toBeInTheDocument();
      expect(screen.getByText("connect ECONNREFUSED")).toBeInTheDocument();
    });
    expect(screen.getByText("5432")).toBeInTheDocument();
    expect(screen.getAllByText("2.3s").length).toBeGreaterThan(0);

    click(screen.getByText("resolver.internal:53"));

    await waitFor(() => {
      expect(screen.getByText("Base URL")).toBeInTheDocument();
      expect(screen.getAllByText("resolver.internal")).not.toHaveLength(0);
      expect(screen.getByText("google-drive, slack")).toBeInTheDocument();
      expect(screen.getByText("DNS_TOKEN")).toBeInTheDocument();
      expect(screen.getByText("Cache Hit")).toBeInTheDocument();
      expect(screen.getByText("URL Rewrite")).toBeInTheDocument();
    });
    expect(
      screen.getByText('{"region":"iad","profile":"primary"}'),
    ).toBeInTheDocument();
    expect(screen.getAllByText("No").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Yes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);

    click(screen.getByLabelText("Type filter"));
    click(getMenuItemCheckboxByText("DNS"));

    await waitFor(() => {
      expect(screen.queryByText("api.service.test:0")).not.toBeInTheDocument();
      expect(screen.getByText("5 types")).toBeInTheDocument();
    });
  });

  it("downloads a completed activity with debug context and network logs", async () => {
    const runId = "a0000000-0000-4000-a000-000000000399";
    const downloads = context.mocks.browser.blobDownload();

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Checkout Export",
          status: "completed",
          prompt: "Export checkout diagnostics",
          startedAt: "2026-03-10T14:56:01Z",
          completedAt: "2026-03-10T14:56:10Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: detailedActivityEvents(),
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );
    context.mocks.api(zeroRunContextContract.getContext, ({ respond }) => {
      return respond(200, codexRunContext(runId));
    });
    const secondDownloadNetworkCursor =
      "time:asc:2026-03-10T14%3A56%3A03Z:cursor-download-2";
    const requestedDownloadNetworkCursors: (string | undefined)[] = [];
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      ({ query, respond }) => {
        requestedDownloadNetworkCursors.push(query.cursor);
        if (query.cursor === undefined) {
          return respond(200, {
            networkLogs: checkoutNetworkLogs(),
            hasMore: true,
            nextCursor: secondDownloadNetworkCursor,
          });
        }

        expect(query.cursor).toBe(secondDownloadNetworkCursor);
        return respond(200, {
          networkLogs: codexNetworkSecondPage(),
          hasMore: true,
          nextCursor: secondDownloadNetworkCursor,
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Checkout Export" }),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Download raw data"));

    await waitFor(() => {
      expect(downloads.downloads).toHaveLength(1);
    });
    const download = downloads.downloads[0];
    if (!download?.blob) {
      throw new Error("Downloaded activity blob was not captured");
    }
    const downloaded = JSON.parse(await download.blob.text()) as {
      meta?: { id?: unknown; displayName?: unknown; status?: unknown };
      events?: unknown[];
      context?: { prompt?: unknown; runId?: unknown };
      networkLogs?: { url?: unknown }[];
    };

    expect(download.filename).toBe(`${runId}-logs.json`);
    expect(downloaded.meta).toMatchObject({
      id: runId,
      displayName: "Checkout Export",
      status: "completed",
    });
    expect(downloaded.events?.length).toBeGreaterThan(0);
    expect(downloaded.context).toMatchObject({
      prompt: "Repair the billing worker retry path",
      runId,
    });
    expect(downloaded.networkLogs?.[0]?.url).toBe(
      "https://payments.example.test/v1/checkout",
    );
    expect(
      downloaded.networkLogs?.some((log) => {
        return log.url === "http://metadata.google.internal/latest/meta-data";
      }),
    ).toBeTruthy();
    expect(requestedDownloadNetworkCursors).toStrictEqual([
      undefined,
      secondDownloadNetworkCursor,
    ]);
    expect(downloads.revokedUrls).toContain(download.url);
  });

  it("propagates abort while fetching raw download extras", async () => {
    const runId = "a0000000-0000-4000-a000-000000000397";
    const resetDownloadSignal$ = resetSignal();
    const downloadSignal = context.store.set(
      resetDownloadSignal$,
      context.signal,
    );
    let contextRequestStarted = false;
    let contextRequestAborted = false;
    let networkRequestStarted = false;
    let networkRequestAborted = false;

    context.mocks.api(zeroRunContextContract.getContext, async ({ never }) => {
      contextRequestStarted = true;
      try {
        return await never();
      } finally {
        contextRequestAborted = true;
      }
    });
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      async ({ never }) => {
        networkRequestStarted = true;
        try {
          return await never();
        } finally {
          networkRequestAborted = true;
        }
      },
    );

    const promise = context.store.set(
      fetchDownloadExtra$,
      runId,
      downloadSignal,
    );
    await waitFor(() => {
      expect(contextRequestStarted).toBeTruthy();
      expect(networkRequestStarted).toBeTruthy();
    });

    context.store.set(resetDownloadSignal$, context.signal);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });

    await waitFor(() => {
      expect(contextRequestAborted).toBeTruthy();
      expect(networkRequestAborted).toBeTruthy();
    });
  });

  it("shows codex run steps, debug context, runner reuse, and network paging", async () => {
    const runId = "a0000000-0000-4000-a000-000000000299";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Codex Billing Repair",
          framework: "codex",
          status: "completed",
          prompt: "Repair the billing worker retry path",
          appendSystemPrompt: "Use Codex event logs when available",
          startedAt: "2026-03-10T15:00:01Z",
          completedAt: "2026-03-10T15:00:18Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: codexActivityEvents(),
          hasMore: false,
          framework: "codex",
        } satisfies AgentEventsResponse);
      },
    );
    context.mocks.api(zeroRunContextContract.getContext, ({ respond }) => {
      return respond(200, codexRunContext(runId));
    });
    context.mocks.api(zeroRunRunnerContract.getRunner, ({ respond }) => {
      return respond(200, { sandboxReuseResult: "reused" });
    });
    const secondNetworkPageCursor =
      "time:asc:2026-03-10T15%3A00%3A02Z:cursor-network-2";
    const requestedNetworkCursors: (string | undefined)[] = [];
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      ({ query, respond }) => {
        requestedNetworkCursors.push(query.cursor);

        if (query.cursor === undefined) {
          return respond(200, {
            networkLogs: codexNetworkFirstPage(),
            hasMore: true,
            nextCursor: secondNetworkPageCursor,
          });
        }

        expect(query.cursor).toBe(secondNetworkPageCursor);
        return respond(200, {
          networkLogs: codexNetworkSecondPage(),
          hasMore: true,
          nextCursor: secondNetworkPageCursor,
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Codex Billing Repair" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("17.0s")).toBeInTheDocument();
    expect(screen.getByText("Initialize")).toBeInTheDocument();
    expect(
      screen.getByText("I checked the billing worker retry path."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("[thinking] Follow the failed retry through the logs."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Bash")).not.toHaveLength(0);
    expect(
      screen.getAllByText("pnpm test --filter billing-worker"),
    ).not.toHaveLength(0);
    expect(screen.getByText("billing worker failed")).toBeInTheDocument();
    expect(screen.getAllByText("Read")).not.toHaveLength(0);
    expect(screen.getAllByText("Edit")).not.toHaveLength(0);
    expect(screen.getAllByText("src/billing/worker.ts")).not.toHaveLength(0);
    expect(screen.getByText("export const worker = true;")).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => {
        return (
          element?.tagName === "PRE" &&
          element?.textContent?.includes("- old retry") === true &&
          element.textContent.includes("+ new retry")
        );
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("add src/billing/retry.test.ts"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Codex unknown_item/u)).toBeInTheDocument();
    expect(screen.getByText("1 turns")).toBeInTheDocument();
    expect(screen.getByText("1 models")).toBeInTheDocument();

    await fill(
      screen.getByPlaceholderText("Search steps"),
      " billing worker failed ",
    );

    await waitFor(() => {
      expect(
        screen.getByText(/\([0-9]+\/[0-9]+ matched\)/u),
      ).toBeInTheDocument();
      expect(screen.getAllByText("billing worker failed")).not.toHaveLength(0);
      expect(
        document.querySelector('mark[data-match-index="0"]')?.textContent,
      ).toBe("billing worker failed");
    });
    expect(screen.queryByText(/Codex unknown_item/u)).not.toBeInTheDocument();

    click(getTabByText("Context"));

    await waitFor(() => {
      expect(screen.getByText("OPENAI_API_KEY")).toBeInTheDocument();
    });
    expect(screen.getByText("CODEX_RETRY")).toBeInTheDocument();
    expect(screen.getByText("codex-workspace-storage")).toBeInTheDocument();
    expect(screen.getByText("codex-artifact-storage")).toBeInTheDocument();
    expect(
      screen.getAllByText((_, element) => {
        return (
          element?.tagName === "PRE" &&
          element.textContent?.includes("responses-write") === true
        );
      }),
    ).not.toHaveLength(0);

    click(getTabByText("Runner"));

    await waitFor(() => {
      expect(screen.getByText("Reused")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Sandbox was unparked from the idle pool."),
    ).toBeInTheDocument();

    click(getTabByText("Network"));

    await waitFor(() => {
      expect(
        screen.getByText("https://api.openai.test/v1/responses"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("320ms")).toBeInTheDocument();

    click(getButtonByText("Load more"));

    await waitFor(() => {
      expect(
        screen.getByText("http://metadata.google.internal/latest/meta-data"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("403")).toBeInTheDocument();
    expect(screen.getByText("1.0s")).toBeInTheDocument();
    expect(requestedNetworkCursors).toStrictEqual([
      undefined,
      secondNetworkPageCursor,
    ]);
    await waitFor(() => {
      expect(screen.queryByText("Load more")).not.toBeInTheDocument();
    });
  });

  it("ignores stale network page responses after changing activity", async () => {
    const firstRunId = "a0000000-0000-4000-a000-000000000501";
    const secondRunId = "a0000000-0000-4000-a000-000000000502";
    const firstCursor = "time:asc:2026-03-10T17%3A00%3A01Z:cursor-first-2";
    const secondCursor = "time:asc:2026-03-10T18%3A00%3A01Z:cursor-second-2";
    const stalePage = Promise.withResolvers<void>();
    let firstSecondPageRequested = false;

    const logEntry = (timestamp: string, url: string): NetworkLogEntry => {
      return {
        timestamp,
        type: "http",
        action: "ALLOW",
        method: "GET",
        url,
        status: 200,
        latency_ms: 10,
      };
    };

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
      const id = String(params.id);
      return respond(
        200,
        makeLogDetail({
          id,
          displayName: id === firstRunId ? "First Activity" : "Second Activity",
          status: "completed",
          prompt: "Inspect network pagination",
          startedAt: "2026-03-10T17:00:00Z",
          completedAt: "2026-03-10T17:00:10Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      async ({ params, query, respond }) => {
        const id = String(params.id);

        if (id === firstRunId && query.cursor === undefined) {
          return respond(200, {
            networkLogs: [
              logEntry(
                "2026-03-10T17:00:01.000Z",
                "https://first.example.test/start",
              ),
            ],
            hasMore: true,
            nextCursor: firstCursor,
          });
        }

        if (id === firstRunId) {
          expect(query.cursor).toBe(firstCursor);
          firstSecondPageRequested = true;
          await stalePage.promise;
          return respond(200, {
            networkLogs: [
              logEntry(
                "2026-03-10T17:00:02.000Z",
                "https://stale.example.test/old-run",
              ),
            ],
            hasMore: false,
          });
        }

        if (query.cursor === undefined) {
          return respond(200, {
            networkLogs: [
              logEntry(
                "2026-03-10T18:00:01.000Z",
                "https://second.example.test/start",
              ),
            ],
            hasMore: true,
            nextCursor: secondCursor,
          });
        }

        expect(query.cursor).toBe(secondCursor);
        return respond(200, {
          networkLogs: [
            logEntry(
              "2026-03-10T18:00:02.000Z",
              "https://second.example.test/next",
            ),
          ],
          hasMore: false,
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${firstRunId}?tab=network`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "First Activity" }),
      ).toBeInTheDocument();
    });

    const firstLoad = context.store.set(
      loadNetworkLogsNextPage$,
      context.signal,
    );

    await waitFor(async () => {
      const data = await context.store.get(zeroActivityNetworkLogs$);
      expect(
        data.networkLogs.some((entry) => {
          return entry.url === "https://first.example.test/start";
        }),
      ).toBeTruthy();
      expect(firstSecondPageRequested).toBeTruthy();
    });

    context.store.set(pushPathSilently$, ROUTES.activityDetail, {
      activityRunId: secondRunId,
    });

    await waitFor(async () => {
      const data = await context.store.get(zeroActivityNetworkLogs$);
      expect(
        data.networkLogs.some((entry) => {
          return entry.url === "https://second.example.test/start";
        }),
      ).toBeTruthy();
      expect(data.loading).toBeFalsy();
    });

    const secondLoad = context.store.set(
      loadNetworkLogsNextPage$,
      context.signal,
    );
    await secondLoad;
    stalePage.resolve();
    await firstLoad;

    const data = await context.store.get(zeroActivityNetworkLogs$);
    const urls = data.networkLogs.map((entry) => {
      return entry.url;
    });

    expect(urls).toContain("https://second.example.test/start");
    expect(urls).toContain("https://second.example.test/next");
    expect(urls).not.toContain("https://stale.example.test/old-run");
  });

  it("does not render stale context after changing activity", async () => {
    const firstRunId = "a0000000-0000-4000-a000-000000000505";
    const secondRunId = "a0000000-0000-4000-a000-000000000506";
    const secondContextResponse = Promise.withResolvers<void>();
    const secondContextRequested = Promise.withResolvers<void>();

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
      const id = String(params.id);
      return respond(
        200,
        makeLogDetail({
          id,
          displayName: id === firstRunId ? "First Activity" : "Second Activity",
          status: "completed",
          prompt: "Inspect stale context rendering",
          startedAt: "2026-03-10T18:40:00Z",
          completedAt: "2026-03-10T18:40:10Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );
    context.mocks.api(
      zeroRunContextContract.getContext,
      async ({ params, respond }) => {
        const id = String(params.id);
        if (id === secondRunId) {
          secondContextRequested.resolve();
          await secondContextResponse.promise;
          return respond(200, {
            ...codexRunContext(secondRunId),
            secretNames: ["SECOND_ONLY_SECRET"],
          });
        }

        return respond(200, {
          ...codexRunContext(firstRunId),
          secretNames: ["FIRST_ONLY_SECRET"],
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${firstRunId}?tab=context`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("FIRST_ONLY_SECRET")).toBeInTheDocument();
    });

    context.store.set(detachedNavigateTo$, ROUTES.activityDetail, {
      pathParams: { activityRunId: secondRunId },
      searchParams: new URLSearchParams("tab=context"),
    });
    await secondContextRequested.promise;

    try {
      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Second Activity" }),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText("FIRST_ONLY_SECRET")).not.toBeInTheDocument();
    } finally {
      secondContextResponse.resolve();
    }

    await waitFor(() => {
      expect(screen.getByText("SECOND_ONLY_SECRET")).toBeInTheDocument();
    });
  });

  it("does not render stale step messages after changing activity", async () => {
    const firstRunId = "a0000000-0000-4000-a000-000000000503";
    const secondRunId = "a0000000-0000-4000-a000-000000000504";
    const secondEventsResponse = Promise.withResolvers<void>();
    const secondEventsRequested = Promise.withResolvers<void>();

    const assistantTextEvent = (
      sequenceNumber: number,
      text: string,
    ): AgentEvent => {
      return {
        sequenceNumber,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text }],
          },
        },
        createdAt: "2026-03-10T18:30:01Z",
      };
    };

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
      const id = String(params.id);
      return respond(
        200,
        makeLogDetail({
          id,
          displayName: id === firstRunId ? "First Activity" : "Second Activity",
          status: "completed",
          prompt: "Inspect stale step rendering",
          startedAt: "2026-03-10T18:30:00Z",
          completedAt: "2026-03-10T18:30:10Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      async ({ params, respond }) => {
        const id = String(params.id);
        if (id === secondRunId) {
          secondEventsRequested.resolve();
          await secondEventsResponse.promise;
          return respond(200, {
            events: [
              assistantTextEvent(1, "new run step should render after load"),
            ],
            hasMore: false,
            framework: "claude-code",
          } satisfies AgentEventsResponse);
        }

        return respond(200, {
          events: [assistantTextEvent(1, "old run step should not remain")],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${firstRunId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("old run step should not remain"),
      ).toBeInTheDocument();
    });

    context.store.set(detachedNavigateTo$, ROUTES.activityDetail, {
      pathParams: { activityRunId: secondRunId },
    });
    await secondEventsRequested.promise;

    try {
      await waitFor(() => {
        expect(
          screen.queryByText("old run step should not remain"),
        ).not.toBeInTheDocument();
      });
    } finally {
      secondEventsResponse.resolve();
    }

    await waitFor(() => {
      expect(
        screen.getByText("new run step should render after load"),
      ).toBeInTheDocument();
    });
  });

  it("shows codex fallback event rows for failed activity details", async () => {
    const runId = "a0000000-0000-4000-a000-000000000300";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Codex Edge Cases",
          framework: "codex",
          status: "failed",
          prompt: "Exercise Codex edge event rows",
          error: "Codex stream disconnected.",
          startedAt: "2026-03-10T15:30:01Z",
          completedAt: "2026-03-10T15:30:09Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: codexFallbackActivityEvents(),
          hasMore: false,
          framework: "codex",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Codex Edge Cases" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Codex item.completed")).toBeInTheDocument();
    expect(screen.queryByText(/Codex agent_message/u)).not.toBeInTheDocument();
    expect(screen.getByText(/\[files\] Files changed/u)).toBeInTheDocument();
    expect(screen.queryByText(/unknown path/u)).not.toBeInTheDocument();
    expect(screen.getByText(/src\/late-valid\.ts/u)).toBeInTheDocument();
    expect(screen.queryByText(/\+1 more changes/u)).not.toBeInTheDocument();
    expect(screen.getAllByText("Write")).not.toHaveLength(0);
    expect(screen.getByText("src/generated.ts")).toBeInTheDocument();
    expect(screen.getByText("File operation completed")).toBeInTheDocument();
    expect(screen.getAllByText("Read")).not.toHaveLength(0);
    expect(screen.getByText("src/edge.ts")).toBeInTheDocument();
    expect(screen.getByText("File read completed")).toBeInTheDocument();
    expect(
      screen.getByText("Codex build failed before retry."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Codex stream disconnected.")).not.toHaveLength(
      0,
    );
  });

  it("marks raw success false result events as failed summaries", async () => {
    const runId = "a0000000-0000-4000-a000-000000000302";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Raw Result Status",
          status: "failed",
          prompt: "Render raw result status",
          error: "Raw result failed",
          startedAt: "2026-03-10T16:10:01Z",
          completedAt: "2026-03-10T16:10:02Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [
            {
              sequenceNumber: 0,
              eventType: "result",
              eventData: {
                type: "result",
                success: false,
                result: "Raw result failed",
                num_turns: 1,
                duration_ms: 1000,
              },
              createdAt: "2026-03-10T16:10:02Z",
            },
          ],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Raw Result Status" }),
      ).toBeInTheDocument();
    });

    const summaryRow = screen.getByText("Summary").closest("div");
    expect(summaryRow?.querySelector('[data-variant="error"]')).toBeTruthy();
    expect(screen.getAllByText("Raw result failed")).not.toHaveLength(0);
  });

  it("marks failed task notification statuses as failed task rows", async () => {
    const runId = "a0000000-0000-4000-a000-000000000304";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Cancelled Task Status",
          status: "failed",
          prompt: "Render cancelled task status",
          startedAt: "2026-03-10T16:15:01Z",
          completedAt: "2026-03-10T16:15:02Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [
            {
              sequenceNumber: 0,
              eventType: "system",
              eventData: {
                subtype: "task_started",
                task_id: "cancelled-task",
              },
              createdAt: "2026-03-10T16:15:01Z",
            },
            {
              sequenceNumber: 1,
              eventType: "system",
              eventData: {
                subtype: "task_notification",
                task_id: "cancelled-task",
                status: "cancelled",
                summary: "Task was cancelled",
              },
              createdAt: "2026-03-10T16:15:02Z",
            },
            {
              sequenceNumber: 2,
              eventType: "system",
              eventData: {
                subtype: "task_started",
                task_id: "declined-task",
              },
              createdAt: "2026-03-10T16:15:03Z",
            },
            {
              sequenceNumber: 3,
              eventType: "system",
              eventData: {
                subtype: "task_notification",
                task_id: "declined-task",
                status: "declined",
                summary: "Task was declined",
              },
              createdAt: "2026-03-10T16:15:04Z",
            },
          ],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Cancelled Task Status" }),
      ).toBeInTheDocument();
    });

    const taskSummary = screen.getByText("Task was cancelled");
    expect(
      taskSummary.parentElement?.querySelector('[data-variant="error"]'),
    ).toBeTruthy();
    const declinedTaskSummary = screen.getByText("Task was declined");
    expect(
      declinedTaskSummary.parentElement?.querySelector(
        '[data-variant="error"]',
      ),
    ).toBeTruthy();
  });

  it("keeps rendering activity details when event payloads are malformed", async () => {
    const runId = "a0000000-0000-4000-a000-000000000303";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Malformed Event Payloads",
          status: "completed",
          prompt: "Render malformed activity payloads",
          startedAt: "2026-03-10T16:20:01Z",
          completedAt: "2026-03-10T16:20:03Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [
            {
              sequenceNumber: 0,
              eventType: "system",
              eventData: {
                subtype: "init",
                tools: "Bash",
                agents: ["checkout-agent", 1],
                slash_commands: { review: true },
              },
              createdAt: "2026-03-10T16:20:01Z",
            },
            {
              sequenceNumber: 1,
              eventType: "assistant",
              eventData: null,
              createdAt: "2026-03-10T16:20:02Z",
            },
            {
              sequenceNumber: 2,
              eventType: "assistant",
              eventData: {
                message: {
                  content: { type: "text", text: "not an array" },
                },
              },
              createdAt: "2026-03-10T16:20:03Z",
            },
            {
              sequenceNumber: 3,
              eventType: "assistant",
              eventData: {
                message: {
                  content: [
                    {
                      type: "text",
                      text: "Literal [ bracket assistant output",
                    },
                  ],
                },
              },
              createdAt: "2026-03-10T16:20:04Z",
            },
            {
              sequenceNumber: 4,
              eventType: "assistant",
              eventData: {
                message: {
                  content: [
                    null,
                    1,
                    {
                      type: "tool_use",
                      id: "tool-todo-malformed",
                      name: "TodoWrite",
                      input: {
                        todos: [
                          null,
                          "plain malformed todo",
                          {
                            content: "Recover malformed todo",
                            status: "in_progress",
                          },
                        ],
                      },
                    },
                    {
                      type: "tool_use",
                      id: "tool-bash-malformed",
                      name: "Bash",
                      input: { command: { nested: true } },
                    },
                  ],
                },
              },
              createdAt: "2026-03-10T16:20:05Z",
            },
            {
              sequenceNumber: 5,
              eventType: "user",
              eventData: {
                message: {
                  content: [
                    null,
                    {
                      type: "tool_result",
                      tool_use_id: "tool-bash-malformed",
                      content: { ok: true },
                      is_error: false,
                    },
                  ],
                },
                tool_use_result: { durationMs: "5", bytes: { nested: true } },
              },
              createdAt: "2026-03-10T16:20:06Z",
            },
            {
              sequenceNumber: 6,
              eventType: "result",
              eventData: null,
              createdAt: "2026-03-10T16:20:07Z",
            },
            {
              sequenceNumber: 7,
              eventType: "result",
              eventData: {
                type: "result",
                is_error: false,
                result: "Ignored malformed result stats.",
                num_turns: 1.5,
                duration_ms: Number.NaN,
                modelUsage: {
                  malformed: {
                    inputTokens: Number.NaN,
                    outputTokens: 1.5,
                  },
                },
              },
              createdAt: "2026-03-10T16:20:08Z",
            },
            {
              sequenceNumber: 8,
              eventType: "result",
              eventData: {
                type: "result",
                is_error: false,
                result: "Survived malformed payloads.",
                num_turns: 1,
                duration_ms: 100,
              },
              createdAt: "2026-03-10T16:20:09Z",
            },
            {
              sequenceNumber: 9,
              eventType: "system",
              eventData: {
                subtype: "task_started",
                task_id: "task-malformed",
                tool_use_id: "task-tool-malformed",
                description: { nested: true },
              },
              createdAt: "2026-03-10T16:20:10Z",
            },
            {
              sequenceNumber: 10,
              eventType: "system",
              eventData: {
                subtype: "task_notification",
                task_id: "task-malformed",
                status: { nested: true },
                summary: { nested: true },
              },
              createdAt: "2026-03-10T16:20:11Z",
            },
          ],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Malformed Event Payloads" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Initialize")).toBeInTheDocument();
    expect(screen.getByText("1 agents")).toBeInTheDocument();
    expect(screen.getAllByText("Recover malformed todo")).not.toHaveLength(0);
    expect(
      screen.getByText("Survived malformed payloads."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ignored malformed result stats."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/u)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("1.5 turns");
    expect(document.body.textContent).not.toContain("out: 1.5");

    await fill(screen.getByPlaceholderText("Search steps"), "[");

    await waitFor(() => {
      expect(
        screen.getByText(/\([0-9]+\/[0-9]+ matched\)/u),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Literal [ bracket assistant output"),
      ).toBeInTheDocument();
    });
  });

  it("normalizes codex app-server adapter events in activity details", async () => {
    const runId = "a0000000-0000-4000-a000-000000000301";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Codex Adapter Events",
          framework: "codex",
          status: "failed",
          prompt: "Exercise Codex adapter events",
          error: "Adapter transport failed",
          startedAt: "2026-03-10T16:00:01Z",
          completedAt: "2026-03-10T16:00:19Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: codexAdapterActivityEvents(),
          hasMore: false,
          framework: "codex",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Codex Adapter Events" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText("[warning] Retryable adapter warning"),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => {
        return (
          element?.tagName === "P" &&
          element?.textContent?.includes("Refresh adapter event plan") === true
        );
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Collect app-server events/u)).toBeInTheDocument();
    expect(screen.queryByText(/\+2 more steps/u)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Ship Platform normalizer coverage\./u),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Visible Codex assistant text before failed summary."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Visible Codex assistant text after top-level error."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Visible Codex assistant text after recoverable error."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Bash")).not.toHaveLength(0);
    expect(screen.getAllByText("pnpm test adapter")).not.toHaveLength(0);
    expect(
      screen.getByText((_, element) => {
        return (
          element?.tagName === "PRE" &&
          element.textContent ===
            "  partial adapter output\nadapter output tail  \nCommand refused by policy (no shell grant)"
        );
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => {
        return (
          element?.tagName === "PRE" &&
          typeof element.className === "string" &&
          element.className.includes("text-red-600") &&
          element.textContent === "camel exit failure"
        );
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Read")).not.toHaveLength(0);
    expect(screen.getByText("src/secret.ts")).toBeInTheDocument();
    expect(screen.getAllByText("Read declined by sandbox")).not.toHaveLength(0);
    expect(
      screen.getAllByText((_, element) => {
        return (
          element?.tagName === "DIV" &&
          typeof element.className === "string" &&
          element.className.includes("wmde-markdown") &&
          element?.textContent?.includes("[files] Files changed:") === true &&
          element.textContent.includes("Status: failed") &&
          element.textContent.includes("Patch failed before write") &&
          element.textContent.includes("modify src/adapter.ts")
        );
      }),
    ).toHaveLength(1);
    expect(screen.getByText(/Codex serverOperation/u)).toBeInTheDocument();
    expect(
      screen.getByText(/details: \{nested=bounded detail\}/u),
    ).toBeInTheDocument();
    expect(document.body.textContent).toContain("verbose adapter output");
    expect(document.body.textContent).not.toContain("aggregatedOutput:");
    expect(document.body.textContent).not.toContain(LONG_GENERIC_CODEX_OUTPUT);
    expect(
      screen.getAllByText(/Adapter transport failed \(socket closed\)/u),
    ).toHaveLength(1);
    expect(
      screen.getByText(/Turn failed \(model stopped\)/u),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => {
        return (
          element?.tagName === "DIV" &&
          typeof element.className === "string" &&
          element.className.includes("wmde-markdown") &&
          element.textContent?.includes(
            "Adapter transport failed (socket closed)",
          ) === true &&
          element.textContent.includes("Turn failed (model stopped)")
        );
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Different turn top-level failure"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Different turn interrupted \(user interrupt\)/u),
    ).toBeInTheDocument();
    expect(screen.getByText("Deep nested adapter failure")).toBeInTheDocument();
    expect(screen.getByText(/^Turn failed$/u)).toBeInTheDocument();
    expect(screen.getByText("Recoverable adapter error")).toBeInTheDocument();
    const detailText = document.body.textContent ?? "";
    expect(detailText.indexOf("Recoverable adapter error")).toBeGreaterThan(-1);
    expect(
      detailText.indexOf(
        "Visible Codex assistant text after recoverable error.",
      ),
    ).toBeGreaterThan(-1);
    expect(detailText.indexOf("Recoverable adapter error")).toBeLessThan(
      detailText.indexOf(
        "Visible Codex assistant text after recoverable error.",
      ),
    );
    expect(detailText.indexOf("9.9s")).toBeGreaterThan(-1);
    expect(detailText.indexOf("Recoverable adapter error")).toBeLessThan(
      detailText.indexOf("9.9s"),
    );
    expect(screen.queryByText(/\[object Object\]/u)).not.toBeInTheDocument();

    await fill(
      screen.getByPlaceholderText("Search steps"),
      "Adapter transport",
    );

    await waitFor(() => {
      expect(
        screen.getByText(/\([0-9]+\/[0-9]+ matched\)/u),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Adapter transport failed \(socket closed\)/u),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText("Different turn top-level failure"),
    ).not.toBeInTheDocument();
  });

  it("shows a not-found state for an inaccessible activity", async () => {
    const runId = "a0000000-0000-4000-a000-000000000404";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Log not found")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "This log doesn't exist or you don't have permission to view it in the current workspace.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Back to activity")).toBeInTheDocument();
  });

  it("shows empty network logs and unknown runner reuse for an older activity", async () => {
    const runId = "a0000000-0000-4000-a000-000000000405";

    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(
        200,
        makeLogDetail({
          id: runId,
          displayName: "Legacy Activity",
          status: "completed",
          prompt: "Review an older run",
          startedAt: "2026-03-10T17:00:01Z",
          completedAt: "2026-03-10T17:00:04Z",
        }),
      );
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        } satisfies AgentEventsResponse);
      },
    );
    context.mocks.api(zeroRunRunnerContract.getRunner, ({ respond }) => {
      return respond(200, { sandboxReuseResult: null });
    });
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      ({ respond }) => {
        return respond(200, { networkLogs: [], hasMore: false });
      },
    );

    detachedSetupPage({
      context,
      path: `/activities/${runId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Legacy Activity" }),
      ).toBeInTheDocument();
    });

    click(getTabByText("Runner"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Unknown (older run, recorded before sandbox reuse tracking was added).",
        ),
      ).toBeInTheDocument();
    });

    click(getTabByText("Network"));

    await waitFor(() => {
      expect(screen.getByText("No network logs")).toBeInTheDocument();
      expect(
        screen.getByText("No network traffic was recorded for this run."),
      ).toBeInTheDocument();
    });
  });
});
