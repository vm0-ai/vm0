import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../../__tests__/page-helper.ts";
import { type ModelProviderResponse, FeatureSwitchKey } from "@vm0/core";
import { setMockTeam } from "../../../../mocks/handlers/api-agents.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../../mocks/handlers/api-schedules.ts";
import { setMockOrgModelProviders } from "../../../../mocks/handlers/api-org-model-providers.ts";

const context = testContext();
const user = userEvent.setup();

function makeProvider(
  type: ModelProviderResponse["type"],
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: crypto.randomUUID(),
    type,
    framework: "claude-code",
    secretName: "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockScheduleAPIs(providers: ModelProviderResponse[] = []) {
  setMockSchedules([
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000001",
      displayName: "Zero",
      name: "morning-task",
      cronExpression: "0 9 * * 1-5",
      prompt: "Existing prompt",
    }),
  ]);
  setMockTeam([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "v1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  setMockOrgModelProviders(providers);
}

async function openCreateScheduleDialog(
  providers: ModelProviderResponse[] = [],
) {
  mockScheduleAPIs(providers);
  detachedSetupPage({
    context,
    path: "/schedules",
    featureSwitches: {
      [FeatureSwitchKey.ModelProviderSelection]: true,
    },
  });

  await waitFor(() => {
    expect(screen.getByText(/Add schedule/i)).not.toBeDisabled();
  });

  await user.click(screen.getByText(/Add schedule/i));

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Add schedule" }),
    ).toBeInTheDocument();
  });
}

describe("modelProviderPicker in schedule dialog", () => {
  it("shows inherit placeholder when providers exist", async () => {
    await openCreateScheduleDialog([makeProvider("anthropic-api-key")]);

    await waitFor(() => {
      expect(screen.getByText("Model")).toBeInTheDocument();
    });

    expect(screen.getByText("Inherit from org default")).toBeInTheDocument();
  });

  it("lists provider groups with model options when opened", async () => {
    await openCreateScheduleDialog([makeProvider("anthropic-api-key")]);

    await waitFor(() => {
      expect(screen.getByText("Model")).toBeInTheDocument();
    });

    // Find the model picker combobox (labelled "Model (optional)")
    const modelSection = screen.getByText("Model").closest("div");
    const trigger = within(modelSection!).getByRole("combobox");
    await user.click(trigger);

    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });
  });

  it("surfaces VM0 managed group first with credit multiplier badge", async () => {
    await openCreateScheduleDialog([
      makeProvider("anthropic-api-key"),
      makeProvider("vm0", { isDefault: true }),
    ]);

    await waitFor(() => {
      expect(screen.getByText("Model")).toBeInTheDocument();
    });

    const modelSection = screen.getByText("Model").closest("div");
    const trigger = within(modelSection!).getByRole("combobox");
    await user.click(trigger);

    await waitFor(() => {
      expect(screen.getByText("Built-in model")).toBeInTheDocument();
    });
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
  });
});
