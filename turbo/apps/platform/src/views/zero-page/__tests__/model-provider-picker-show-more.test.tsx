/**
 * Tests for the VM0 model dropdown's "Show all models" collapse.
 *
 * The VM0 group lists 10+ models, which made the chat composer dropdown too
 * tall. The picker now collapses the VM0 group to a primary set (Opus 4.7,
 * Opus 4.6, Sonnet 4.6, DeepSeek V4 Pro) and exposes a Show all / Show fewer
 * toggle. The currently selected model stays visible even when collapsed so
 * the user can always see the highlighted row.
 *
 * Entry point: chat thread page, which embeds the picker via the composer.
 * Mock (external): Web API via MSW (feature switch + org providers + thread).
 * Real (internal): chat composer signals, ModelProviderPicker, Radix Select.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import {
  setMockFeatureSwitches,
  resetMockFeatureSwitches,
} from "../../../mocks/handlers/api-feature-switches.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "thread-test-show-more";
const PROVIDER_ID = "00000000-0000-4000-a000-000000000099";

const PRIMARY_LABELS = [
  "Claude Opus 4.7",
  "Claude Opus 4.6",
  "Claude Sonnet 4.6",
  "DeepSeek V4 Pro",
];
const SECONDARY_LABELS = [
  "GLM-5.1",
  "Claude Haiku 4.5",
  "Kimi K2.6",
  "Kimi K2.5",
  "MiniMax M2.7",
  "DeepSeek V4 Flash",
];

function setupVm0Provider(selectedModel: string): void {
  setMockFeatureSwitches({});
  setMockOrgModelProviders([
    {
      id: PROVIDER_ID,
      type: "vm0",
      framework: "claude-code",
      secretName: null,
      authMethod: null,
      secretNames: null,
      isDefault: true,
      selectedModel,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  mockChatLifecycle({ threadId: THREAD_ID });
  detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

  await waitFor(() => {
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  });

  const trigger = await waitFor(() => {
    return screen.getByRole("combobox");
  });
  await user.click(trigger);

  await waitFor(() => {
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
}

function optionLabels(): string[] {
  return screen.getAllByRole("option").map((el) => {
    return el.textContent ?? "";
  });
}

describe("model-provider-picker — VM0 show more", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockFeatureSwitches();
  });

  // MPKR-SM-001: Collapsed state shows only the four primary models plus the
  // Show all toggle row.
  it("shows only primary VM0 models by default (MPKR-SM-001)", async () => {
    const user = userEvent.setup();
    setupVm0Provider("claude-sonnet-4-6");

    await openPicker(user);

    const labels = optionLabels();
    for (const primary of PRIMARY_LABELS) {
      expect(labels.some((l) => l.includes(primary))).toBe(true);
    }
    for (const secondary of SECONDARY_LABELS) {
      expect(labels.some((l) => l.includes(secondary))).toBe(false);
    }

    expect(
      screen.getByRole("button", { name: /show all models/i }),
    ).toBeInTheDocument();
  });

  // MPKR-SM-002: Clicking "Show all models" reveals the full list and the
  // toggle flips to "Show fewer models".
  it("expands to all VM0 models when toggled (MPKR-SM-002)", async () => {
    const user = userEvent.setup();
    setupVm0Provider("claude-sonnet-4-6");

    await openPicker(user);

    await user.click(screen.getByRole("button", { name: /show all models/i }));

    const labels = optionLabels();
    for (const label of [...PRIMARY_LABELS, ...SECONDARY_LABELS]) {
      expect(labels.some((l) => l.includes(label))).toBe(true);
    }

    expect(
      screen.getByRole("button", { name: /show fewer models/i }),
    ).toBeInTheDocument();
  });

  // MPKR-SM-003: When the active selection is a non-primary model, it stays
  // visible in the collapsed list so the user can see the highlighted row.
  it("keeps the active selection visible when collapsed (MPKR-SM-003)", async () => {
    const user = userEvent.setup();
    setupVm0Provider("kimi-k2.5");

    await openPicker(user);

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("Kimi K2.5"))).toBe(true);
    // Other secondary models remain hidden — only the active one leaks
    // through.
    expect(labels.some((l) => l.includes("MiniMax M2.7"))).toBe(false);
    expect(labels.some((l) => l.includes("DeepSeek V4 Flash"))).toBe(false);
  });
});
