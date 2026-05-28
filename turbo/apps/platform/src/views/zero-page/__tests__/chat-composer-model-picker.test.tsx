import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import {
  resetMockOrgModelPolicies,
  setMockOrgModelPolicies,
} from "../../../mocks/handlers/api-org-model-policies.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import { setChatShortcutHelpOpen$ } from "../../../signals/chat-page/chat-shortcut-help.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "thread-test-model-picker";
const PROVIDER_ID = "00000000-0000-4000-a000-000000000001";
const DEFAULT_MODEL = "claude-sonnet-4-6";

function enableModelPicker(): void {
  setMockFeatureSwitches({});
  setMockOrgModelProviders([
    {
      id: PROVIDER_ID,
      type: "anthropic-api-key",
      framework: "claude-code",
      secretName: "ANTHROPIC_API_KEY",
      authMethod: null,
      secretNames: null,
      isDefault: true,
      selectedModel: DEFAULT_MODEL,
      needsReconnect: false,
      lastRefreshErrorCode: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

async function openThreadWithPicker(): Promise<HTMLTextAreaElement> {
  mockChatLifecycle({ threadId: THREAD_ID });
  detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

  const textarea = await waitFor(() => {
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  });

  // Wait until the picker trigger mounts — its existence is the signal that
  // the modelPicker prop wiring has resolved (feature switch + providers).
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "DeepSeek V4 Pro" }),
    ).toBeInTheDocument();
  });

  return textarea;
}

describe("chat composer — model picker", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockOrgModelPolicies();
  });

  it("opens directly to model options in the model-first chat picker", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({});
    setMockOrgModelProviders([]);

    await openThreadWithPicker();

    await user.click(screen.getByRole("combobox", { name: "DeepSeek V4 Pro" }));

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Use workspace default model")).toBeNull();
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Claude Opus 4\.8/ }),
    ).toBeInTheDocument();
  });

  it("does not open the model picker from mod+alt+.", async () => {
    const user = userEvent.setup();
    enableModelPicker();
    const textarea = await openThreadWithPicker();

    click(textarea);
    await user.keyboard("{Control>}{Alt>}.{/Alt}{/Control}");

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not list model switching in the shortcut help dialog", async () => {
    enableModelPicker();
    await openThreadWithPicker();

    context.store.set(setChatShortcutHelpOpen$, true);

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog", { name: /keyboard shortcuts/i });
    });
    const composerHeading = Array.from(dialog.querySelectorAll("h3")).find(
      (el) => {
        return el.textContent === "Composer";
      },
    );
    expect(composerHeading).toBeDefined();
    const composerSection = composerHeading?.parentElement;
    expect(composerSection).toBeDefined();
    expect(composerSection?.textContent).toContain("Send message");
    expect(composerSection?.textContent).toContain("Blur composer");
    expect(composerSection?.textContent).not.toContain("Switch model");
  });
});

describe("chat composer — mobile icon trigger", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
  });

  // CHAT-MP-MOBILE-001: When the composer renders the picker, the trigger
  // must contain BOTH a mobile-only icon branch (`sm:hidden`) and a
  // desktop-only label branch (`hidden sm:inline-flex`). Both render to the
  // DOM at all times — the visibility switch is pure CSS — so the test can
  // assert the structure directly without viewport simulation.
  it("renders provider icon on mobile and model label on desktop (CHAT-MP-MOBILE-001)", async () => {
    enableModelPicker();
    await openThreadWithPicker();

    const trigger = screen.getByRole("combobox", { name: "DeepSeek V4 Pro" });

    // Desktop branch: label text lives inside a `hidden sm:inline-flex` span.
    const desktopSpan = trigger.querySelector(
      String.raw`span.hidden.sm\:inline-flex`,
    );
    expect(desktopSpan).not.toBeNull();
    expect(desktopSpan?.textContent).toContain("DeepSeek V4 Pro");

    // Mobile branch: provider icon lives inside a `sm:hidden` span.
    const mobileSpan = trigger.querySelector(String.raw`span.sm\:hidden`);
    expect(mobileSpan).not.toBeNull();
    // ProviderIcon renders an `<img alt="">` for known provider types.
    const providerImg = mobileSpan?.querySelector("img");
    expect(providerImg).not.toBeNull();
    expect(providerImg?.getAttribute("alt")).toBe("");
  });

  // CHAT-MP-MOBILE-002: When no provider is marked as the workspace default
  // and the user has not picked a model, `resolved` is null — the trigger
  // falls back to the placeholder label on desktop and must still show an
  // icon (IconCpu) on mobile so the control never appears empty.
  it("falls back to IconCpu on mobile when no provider resolves (CHAT-MP-MOBILE-002)", async () => {
    // A provider exists (so the composer renders the picker) but none is
    // marked as default, so `effectiveDefault` is null.
    setMockFeatureSwitches({});
    resetMockOrgModelProviders();
    setMockOrgModelPolicies([]);

    mockChatLifecycle({ threadId: THREAD_ID });
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    // The trigger aria-label falls back to the placeholder ("Default") when
    // no provider is marked as the inherited default.
    const trigger = await waitFor(() => {
      return screen.getByRole("combobox", { name: "Default" });
    });

    // Desktop branch renders the placeholder label.
    const desktopSpan = trigger.querySelector(
      String.raw`span.hidden.sm\:inline-flex`,
    );
    expect(desktopSpan).not.toBeNull();
    expect(desktopSpan?.textContent).toContain("Default");

    // Mobile branch still exists; since no provider resolved, ProviderIcon's
    // `<img>` is NOT rendered — the IconCpu SVG fallback fills the slot.
    const mobileSpan = trigger.querySelector(String.raw`span.sm\:hidden`);
    expect(mobileSpan).not.toBeNull();
    expect(mobileSpan?.querySelector("img")).toBeNull();
    expect(mobileSpan?.querySelector("svg")).not.toBeNull();
  });
});
