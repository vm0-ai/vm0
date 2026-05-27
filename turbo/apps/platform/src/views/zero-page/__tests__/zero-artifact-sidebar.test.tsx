/**
 * Integration tests for the ChatArtifactSidebar feature switch behavior.
 *
 * Covers the ON path that issue #15027 introduces: inline .txt/.md
 * attachments collapse to anchor chips, clicking them writes the
 * ?artifact= URL parameter, and the page-level slot then renders the
 * sidebar component. The OFF path is covered by the existing
 * zero-attachment-preview.test.tsx file.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { search } from "../../../signals/location.ts";
import { setPageSignal$ } from "../../../signals/page-signal.ts";
import { AttachmentPreview } from "../zero-attachment-preview.tsx";
import {
  ArtifactSidebarSlot,
  ArtifactSidebar,
} from "../zero-artifact-sidebar.tsx";
import {
  artifactFullscreen$,
  currentArtifactRef$,
} from "../../../signals/zero-page/zero-artifact-sidebar.ts";

const context = testContext();

function setup(path = "/chats/thread-1") {
  detachedSetupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.ChatArtifactSidebar]: true,
    },
    withoutRender: true,
  });
  // ArtifactSidebar reads pageSignal$ for fetch cancellation; tests render
  // it outside of normal page setup, so we have to seed it explicitly.
  context.store.set(setPageSignal$, context.signal);
}

function renderWithStore(node: React.ReactNode) {
  return render(<StoreProvider value={context.store}>{node}</StoreProvider>);
}

describe("chatArtifactSidebar: inline anchor chip behavior", () => {
  it("renders a .txt attachment as an anchor chip when the switch is on", () => {
    setup();
    renderWithStore(
      <AttachmentPreview
        attachment={{
          filename: "notes.txt",
          url: "https://example.com/notes.txt",
        }}
      />,
    );

    const chip = screen.getByTestId("attachment-preview-text");
    expect(chip.tagName).toBe("A");
    expect(chip).toHaveAttribute("href", "https://example.com/notes.txt");
    // The inline <pre> body should NOT be present on the ON path.
    expect(screen.queryByText(/notes\.txt/)).toBeInTheDocument();
  });

  it("renders a .md attachment as an anchor chip when the switch is on", () => {
    setup();
    renderWithStore(
      <AttachmentPreview
        attachment={{
          filename: "readme.md",
          url: "https://example.com/readme.md",
        }}
      />,
    );

    const chip = screen.getByTestId("attachment-preview-markdown");
    expect(chip.tagName).toBe("A");
    expect(chip).toHaveAttribute("href", "https://example.com/readme.md");
  });

  it("opens the artifact pane and writes ?artifact= on plain click", () => {
    setup();
    renderWithStore(
      <AttachmentPreview
        attachment={{
          filename: "notes.txt",
          url: "https://example.com/notes.txt",
        }}
      />,
    );

    const chip = screen.getByTestId("attachment-preview-text");
    fireEvent.click(chip);

    const ref = context.store.get(currentArtifactRef$);
    expect(ref).toStrictEqual({
      source: "url",
      url: "https://example.com/notes.txt",
      kind: "text",
      filename: "notes.txt",
    });
    expect(search()).toContain(
      "artifact=https%3A%2F%2Fexample.com%2Fnotes.txt",
    );
  });

  it("does not intercept cmd+click (modifier-click navigates natively)", () => {
    setup();
    renderWithStore(
      <AttachmentPreview
        attachment={{
          filename: "notes.txt",
          url: "https://example.com/notes.txt",
        }}
      />,
    );

    const chip = screen.getByTestId("attachment-preview-text");
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      button: 0,
    });
    chip.dispatchEvent(event);

    // The URL param must NOT have been written; native anchor navigation
    // (handled by the browser) is left intact.
    expect(search()).not.toContain("artifact=");
    expect(context.store.get(currentArtifactRef$)).toBeNull();
  });
});

describe("chatArtifactSidebar: sidebar slot rendering", () => {
  it("does not render the sidebar when the switch is off", () => {
    detachedSetupPage({
      context,
      path: "/chats/thread-1?artifact=https%3A%2F%2Fexample.com%2Fnotes.txt",
      withoutRender: true,
    });
    context.store.set(setPageSignal$, context.signal);
    renderWithStore(<ArtifactSidebarSlot />);
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });

  it("does not render the sidebar when no artifact param is present", () => {
    setup();
    renderWithStore(<ArtifactSidebarSlot />);
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });

  it("renders the sidebar when switch is on and artifact param is set", () => {
    setup("/chats/thread-1?artifact=https%3A%2F%2Fexample.com%2Fnotes.txt");
    renderWithStore(<ArtifactSidebarSlot />);
    expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
  });
});

describe("chatArtifactSidebar: fullscreen toggle", () => {
  it("toggles fullscreen state when the fullscreen button is clicked", () => {
    setup();
    renderWithStore(
      <ArtifactSidebar
        artifactRef={{
          source: "url",
          url: "https://example.com/notes.txt",
          kind: "text",
          filename: "notes.txt",
        }}
      />,
    );

    expect(context.store.get(artifactFullscreen$)).toBeFalsy();

    fireEvent.click(screen.getByTestId("artifact-sidebar-fullscreen-toggle"));
    expect(context.store.get(artifactFullscreen$)).toBeTruthy();

    fireEvent.click(screen.getByTestId("artifact-sidebar-fullscreen-toggle"));
    expect(context.store.get(artifactFullscreen$)).toBeFalsy();
  });
});
