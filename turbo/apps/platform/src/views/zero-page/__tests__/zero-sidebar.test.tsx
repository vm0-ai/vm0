import { describe, expect, it } from "vitest";
import { splitChatThreadListResponse } from "./chat-test-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { screen, waitFor } from "@testing-library/react";
import { featureSwitch$ } from "../../../signals/external/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAPIs({
  threads = [
    {
      id: "thread-1",
      title: "First chat",
      agent: { id: "c0000000-0000-4000-a000-000000000001", avatarUrl: null },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      isRead: false,
      running: false,
    },
    {
      id: "thread-2",
      title: "Second chat",
      agent: { id: "c0000000-0000-4000-a000-000000000001", avatarUrl: null },
      createdAt: "2026-03-09T00:00:00Z",
      updatedAt: "2026-03-09T00:00:00Z",
      isRead: false,
      running: false,
    },
  ],
}: {
  threads?: {
    id: string;
    title: string;
    agent: { id: string; avatarUrl: string | null };
    createdAt: string;
    updatedAt: string;
    isRead: boolean;
    running: boolean;
  }[];
} = {}) {
  server.use(
    mockApi(zeroTeamContract.list, ({ respond }) => {
      return respond(200, [
        {
          id: "c0000000-0000-4000-a000-000000000001",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          customSkills: [],
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse(threads));
    }),
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-user",
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        customSkills: [],
      });
    }),
  );
}

describe("zero sidebar", () => {
  it("should enable dataExport feature switch via localStorage override", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dataExport: true },
    });

    const features = await context.store.get(featureSwitch$);
    expect(features[FeatureSwitchKey.DataExport]).toBeTruthy();
  });

  it("should disable dataExport feature switch when not overridden", async () => {
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { dataExport: false },
    });

    const features = await context.store.get(featureSwitch$);
    expect(features[FeatureSwitchKey.DataExport]).toBeFalsy();
  });

  it("should hide Activity logs when ZeroDebug switch is off", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: false },
    });

    await waitFor(() => {
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
    expect(screen.queryByText("Activity logs")).not.toBeInTheDocument();
  });

  it("should show Activity logs when ZeroDebug switch is on", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
    expect(screen.getByText("Activity logs")).toBeInTheDocument();
  });

  it("should hide Skills when SkillsViewer switch is off", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.SkillsViewer]: false },
    });

    await waitFor(() => {
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
  });

  it("should show Skills when SkillsViewer switch is on", async () => {
    mockAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.SkillsViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Agents")).toBeInTheDocument();
    });
    expect(screen.getByText("Skills")).toBeInTheDocument();
  });
});
