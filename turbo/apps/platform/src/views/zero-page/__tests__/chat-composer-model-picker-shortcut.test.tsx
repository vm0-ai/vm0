/**
 * Integration tests for the chat composer's mod+alt+. shortcut that opens
 * the model picker dropdown, plus the mobile-icon trigger rendering.
 *
 * Entry point: /chats/:id thread page
 * Mock (external): Web API via MSW — feature switch, org model providers,
 *   chat thread row. Internal signals, composer, model-provider-picker,
 *   Radix Select primitive are exercised for real.
 *
 * Behaviour covered:
 * - mod+alt+. focused in the composer textarea opens the model picker's
 *   Radix listbox (controlled open state wired through ModelProviderPicker).
 * - The shortcut help dialog ("?" popup) lists "Switch model" under the
 *   Composer section so users can discover the binding.
 * - When the caller has not opted into a model picker (no modelPicker prop),
 *   the shortcut is a no-op — it must not throw or surface a listbox.
 * - The composer passes `mobileIconTrigger` so the trigger renders the
 *   provider icon on mobile (`sm:hidden`) and the model label on desktop
 *   (`hidden sm:inline-flex`). Both nodes render in the DOM simultaneously
 *   because the switch is pure CSS — no viewport simulation is needed.
 */

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
  setMockFeatureSwitches,
  resetMockFeatureSwitches,
} from "../../../mocks/handlers/api-feature-switches.ts";
import { setChatShortcutHelpOpen$ } from "../../../signals/chat-page/chat-shortcut-help.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "thread-test-shortcut";
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
      screen.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
    ).toBeInTheDocument();
  });

  return textarea;
}

describe("chat composer — mod+alt+. opens the model picker", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockFeatureSwitches();
  });

  // CHAT-SHORT-MP-001
  it("opens the model picker listbox when the user presses mod+alt+. in the textarea", async () => {
    const user = userEvent.setup();
    enableModelPicker();

    const textarea = await openThreadWithPicker();

    // No listbox yet — the picker is closed until the user invokes the shortcut.
    expect(screen.queryByRole("listbox")).toBeNull();

    click(textarea);
    await user.keyboard("{Control>}{Alt>}.{/Alt}{/Control}");

    // Radix Select renders a role="listbox" when opened.
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    // Default model option is present inside the open listbox, confirming the
    // picker wired its provider data into the dropdown body.
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  // CHAT-SHORT-MP-002
  it("is a no-op in the textarea when the model picker is not rendered", async () => {
    // Feature switch off → no picker rendered → shortcut should not crash and
    // should not summon a listbox from elsewhere in the DOM.
    resetMockFeatureSwitches();
    resetMockOrgModelProviders();

    const user = userEvent.setup();
    mockChatLifecycle({ threadId: THREAD_ID });
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    // Picker trigger must not be present when the feature switch is off.
    expect(screen.queryByRole("combobox", { name: /claude/i })).toBeNull();

    click(textarea);
    await user.keyboard("{Control>}{Alt>}.{/Alt}{/Control}");

    // Nothing opens — the binding guard (`if (modelPicker)`) must short-circuit.
    expect(screen.queryByRole("listbox")).toBeNull();
    // And the textarea text must not have captured the period as typed input —
    // processShortcut always calls preventDefault() regardless of the guard.
    expect(textarea.value).toBe("");
  });
});

describe("chat composer — mobile icon trigger", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockFeatureSwitches();
  });

  // CHAT-MP-MOBILE-001: When the composer renders the picker, the trigger
  // must contain BOTH a mobile-only icon branch (`sm:hidden`) and a
  // desktop-only label branch (`hidden sm:inline-flex`). Both render to the
  // DOM at all times — the visibility switch is pure CSS — so the test can
  // assert the structure directly without viewport simulation.
  it("renders provider icon on mobile and model label on desktop (CHAT-MP-MOBILE-001)", async () => {
    enableModelPicker();
    await openThreadWithPicker();

    const trigger = screen.getByRole("combobox", { name: "Claude Sonnet 4.6" });

    // Desktop branch: label text lives inside a `hidden sm:inline-flex` span.
    const desktopSpan = trigger.querySelector(
      String.raw`span.hidden.sm\:inline-flex`,
    );
    expect(desktopSpan).not.toBeNull();
    expect(desktopSpan?.textContent).toContain("Claude Sonnet 4.6");

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
    setMockOrgModelProviders([
      {
        id: PROVIDER_ID,
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: false,
        selectedModel: DEFAULT_MODEL,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

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

describe("chat composer — shortcut help lists the model picker binding", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockFeatureSwitches();
  });

  // CHAT-SHORT-MP-003
  it("shows 'Switch model' under the Composer section of the help dialog", async () => {
    enableModelPicker();
    await openThreadWithPicker();

    // Open the help dialog through the same signal that the shift+/ handler
    // sets. Drives the dialog without depending on the document-level key
    // listener (which this file's other tests exercise separately).
    context.store.set(setChatShortcutHelpOpen$, true);

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog", { name: /keyboard shortcuts/i });
    });

    // Locate the Composer section heading, then assert its sibling list
    // contains the new Switch model entry alongside pre-existing composer
    // bindings. This guards the discoverability fix so a future refactor
    // can't drop the entry silently.
    const composerHeading = Array.from(dialog.querySelectorAll("h3")).find(
      (el) => {
        return el.textContent === "Composer";
      },
    );
    expect(composerHeading).toBeDefined();
    const composerSection = composerHeading?.parentElement;
    expect(composerSection).toBeDefined();
    expect(composerSection?.textContent).toContain("Switch model");
    expect(composerSection?.textContent).toContain("Send message");
    expect(composerSection?.textContent).toContain("Blur composer");
  });
});
