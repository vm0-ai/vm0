import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { FeatureSwitchKey } from "@vm0/core";

const context = testContext();

function makeLogsResponse(
  data: {
    id: string;
    agentId: string;
    displayName: string;
    status: string;
  }[],
) {
  return {
    data: data.map((d) => {
      return {
        ...d,
        sessionId: `session-${d.id}`,
        orgSlug: "test",
        framework: "claude-code",
        triggerSource: "web",
        triggerAgentName: null,
        scheduleId: null,
        createdAt: "2026-03-10T14:56:00Z",
        startedAt: "2026-03-10T14:56:01Z",
        completedAt: "2026-03-10T14:56:10Z",
      };
    }),
    pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
    filters: { statuses: ["completed"], sources: ["web"], agents: ["zero"] },
  };
}

function mockCommonAPIs() {
  server.use(
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({
        composes: [
          {
            id: "c0000000-0000-4000-a000-000000000001",
            name: "zero",
            displayName: "Zero",
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ],
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}
