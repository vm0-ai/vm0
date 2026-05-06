/**
 * Tests for the personal-tier sectioning in the chat composer model picker.
 * Wave 3 of Epic #11868.
 *
 * Entry point: chat thread page, which embeds the picker via the composer.
 * Mock (external): Web API via MSW (feature switch + org/personal providers + thread).
 * Real (internal): composerModelProviders$ signal, ModelProviderPicker, Radix Select.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import {
  setMockPersonalModelProviders,
  resetMockPersonalModelProviders,
} from "../../../mocks/handlers/api-personal-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "thread-test-tiers";

const ORG_ANTHROPIC_ID = "00000000-0000-4000-a000-000000000010";
const ORG_OPENAI_ID = "00000000-0000-4000-a000-000000000011";
const PERSONAL_ANTHROPIC_ID = "00000000-0000-4000-a000-000000000020";
const PERSONAL_OPENAI_ID = "00000000-0000-4000-a000-000000000021";

function makeProvider(
  id: string,
  type: ModelProviderResponse["type"],
  isDefault: boolean,
  selectedModel: string | null,
): ModelProviderResponse {
  return {
    id,
    type,
    framework: "claude-code",
    secretName: null,
    authMethod: null,
    secretNames: null,
    isDefault,
    selectedModel,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

async function openComposerPicker(user: ReturnType<typeof userEvent.setup>) {
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

function listboxText(): string {
  return screen.getByRole("listbox").textContent ?? "";
}

describe("model-provider-picker — personal-tier sectioning (#11959)", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockPersonalModelProviders();
  });

  it("renders no tier headers when the personalModelProvider switch is off", async () => {
    // Even with personal rows seeded, the merged signal must not surface
    // them when the switch is off — server returns 404 for non-eligible
    // callers, and the client signal short-circuits before the fetch.
    setMockFeatureSwitches({});
    setMockOrgModelProviders([
      makeProvider(
        ORG_ANTHROPIC_ID,
        "anthropic-api-key",
        true,
        "claude-opus-4-7",
      ),
    ]);
    setMockPersonalModelProviders([
      makeProvider(PERSONAL_OPENAI_ID, "openai-api-key", true, "gpt-5.4"),
    ]);

    const user = userEvent.setup();
    await openComposerPicker(user);

    const text = listboxText();
    expect(text).not.toContain("Personal");
    expect(text).not.toContain("Workspace");
    expect(text).not.toContain("GPT-5.4");
  });

  it("renders Personal section above Workspace section when switch is on", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    setMockOrgModelProviders([
      makeProvider(
        ORG_ANTHROPIC_ID,
        "anthropic-api-key",
        true,
        "claude-opus-4-7",
      ),
    ]);
    setMockPersonalModelProviders([
      makeProvider(PERSONAL_OPENAI_ID, "openai-api-key", true, "gpt-5.4"),
    ]);

    const user = userEvent.setup();
    await openComposerPicker(user);

    const text = listboxText();
    expect(text).toContain("Personal");
    expect(text).toContain("Workspace");
    // Personal section comes first — its index is lower in the listbox.
    const personalIdx = text.indexOf("Personal");
    const workspaceIdx = text.indexOf("Workspace");
    expect(personalIdx).toBeLessThan(workspaceIdx);
  });

  it("does not render the Personal section header when switch is on but user has no personal rows", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    setMockOrgModelProviders([
      makeProvider(
        ORG_ANTHROPIC_ID,
        "anthropic-api-key",
        true,
        "claude-opus-4-7",
      ),
      makeProvider(ORG_OPENAI_ID, "openai-api-key", false, "gpt-5.4"),
    ]);
    setMockPersonalModelProviders([]);

    const user = userEvent.setup();
    await openComposerPicker(user);

    const text = listboxText();
    // No "Personal" header without any personal rows.
    expect(text).not.toContain("Personal");
    // Workspace section still appears since we have org rows.
    expect(text).toContain("Workspace");
  });

  it("labels each tier's default with its tier-specific badge", async () => {
    // Both tiers carry their own isDefault row. The picker must label
    // them distinctly so the user can tell "my personal pick" from "my
    // org's pick" at a glance.
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    setMockOrgModelProviders([
      makeProvider(
        ORG_ANTHROPIC_ID,
        "anthropic-api-key",
        true,
        "claude-opus-4-7",
      ),
    ]);
    setMockPersonalModelProviders([
      makeProvider(
        PERSONAL_ANTHROPIC_ID,
        "anthropic-api-key",
        true,
        "claude-opus-4-6",
      ),
    ]);

    const user = userEvent.setup();
    await openComposerPicker(user);

    const text = listboxText();
    expect(text).toContain("Your default");
    expect(text).toContain("Workspace default");
  });

  it("does not render the Personal section header when the user has no personal rows but switch is on (org-only)", async () => {
    // Edge variant — the previous test confirmed this; the dual case
    // here doubles down by also confirming that when only an org row is
    // default, the badge still reads Workspace default (not Your default).
    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    setMockOrgModelProviders([
      makeProvider(
        ORG_ANTHROPIC_ID,
        "anthropic-api-key",
        true,
        "claude-opus-4-7",
      ),
    ]);
    setMockPersonalModelProviders([]);

    const user = userEvent.setup();
    await openComposerPicker(user);

    const text = listboxText();
    expect(text).toContain("Workspace default");
    expect(text).not.toContain("Your default");
  });
});
