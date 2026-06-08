import { computed } from "ccstate";
import { describe, expect, it, vi } from "vitest";
import { createPushStateMock } from "../../../__tests__/page-helper.ts";
import { mockLocation } from "../../location.ts";
import { setPageSignal$ } from "../../page-signal.ts";
import { createPresentationDraftByUrlFactory } from "../presentation-html-editor-draft.ts";
import {
  presentationHtmlPreviewUrl,
  presentationHtmlRefreshVersion$,
  refreshPresentationHtmlPreviews$,
} from "../presentation-html-cache-bust.ts";
import {
  closePresentationEditor$,
  currentArtifactRef$,
  currentArtifactInboxThreadId$,
  currentPresentationEditorUrl$,
  openArtifactSidebarPreview$,
  openPresentationEditor$,
} from "../zero-artifact-sidebar.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();

describe("presentation HTML editor signals", () => {
  it("versions valid preview URLs and preserves invalid URLs", () => {
    expect(
      presentationHtmlPreviewUrl("https://deck.sites.vm0.io/index.html", 0),
    ).toBe("https://deck.sites.vm0.io/index.html");
    expect(
      presentationHtmlPreviewUrl("https://deck.sites.vm0.io/index.html", 3),
    ).toBe("https://deck.sites.vm0.io/index.html?_vm0_presentation_version=3");
    expect(presentationHtmlPreviewUrl("not a url", 3)).toBe("not a url");
  });

  it("increments the presentation preview refresh version", () => {
    expect(context.store.get(presentationHtmlRefreshVersion$)).toBe(0);

    context.store.set(refreshPresentationHtmlPreviews$);
    context.store.set(refreshPresentationHtmlPreviews$);

    expect(context.store.get(presentationHtmlRefreshVersion$)).toBe(2);
  });

  it("caches presentation drafts until invalidated", async () => {
    context.store.set(setPageSignal$, context.signal);
    const load = vi.fn((url: string) => {
      return Promise.resolve(`draft:${url}:${load.mock.calls.length}`);
    });
    const factory = createPresentationDraftByUrlFactory(load);
    const first = factory.get("https://deck.sites.vm0.io");
    const second = factory.get("https://deck.sites.vm0.io");

    expect(second).toBe(first);
    await expect(context.store.get(first)).resolves.toBe(
      "draft:https://deck.sites.vm0.io:1",
    );
    expect(load).toHaveBeenCalledTimes(1);

    factory.invalidate("https://deck.sites.vm0.io");
    const third = factory.get("https://deck.sites.vm0.io");

    expect(third).not.toBe(first);
    await expect(context.store.get(third)).resolves.toBe(
      "draft:https://deck.sites.vm0.io:2",
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("opens and closes the presentation editor through query params", () => {
    createPushStateMock(context.signal);
    mockLocation(
      {
        pathname: "/chats/thread-1",
        search: "?artifact=https%3A%2F%2Fold.test",
      },
      context.signal,
    );

    context.store.set(openPresentationEditor$, "https://deck.sites.vm0.io");

    expect(context.store.get(currentPresentationEditorUrl$)).toBe(
      "https://deck.sites.vm0.io",
    );
    expect(context.store.get(currentArtifactRef$)).toBeNull();
    expect(context.store.get(currentArtifactInboxThreadId$)).toBeNull();

    context.store.set(closePresentationEditor$);

    expect(context.store.get(currentPresentationEditorUrl$)).toBeNull();
  });

  it("keeps presentation editor state separate from artifact preview state", () => {
    createPushStateMock(context.signal);
    mockLocation(
      {
        pathname: "/chats/thread-1",
        search:
          "?presentation-editor=https%3A%2F%2Fdeck.sites.vm0.io&artifact-fullscreen=1",
      },
      context.signal,
    );

    context.store.set(
      openArtifactSidebarPreview$,
      "https://report.test/report.html",
    );

    expect(context.store.get(currentPresentationEditorUrl$)).toBe(
      "https://deck.sites.vm0.io",
    );
    expect(context.store.get(currentArtifactRef$)).toMatchObject({
      source: "url",
      url: "https://report.test/report.html",
    });
  });

  it("does not reuse cached computed values across different URLs", async () => {
    context.store.set(setPageSignal$, context.signal);
    const load = vi.fn((url: string) => {
      return Promise.resolve(url);
    });
    const factory = createPresentationDraftByUrlFactory(load);
    const first = factory.get("https://one.sites.vm0.io");
    const second = factory.get("https://two.sites.vm0.io");

    expect(second).not.toBe(first);
    await expect(
      context.store.get(
        computed((get) => {
          return Promise.all([get(first), get(second)]);
        }),
      ),
    ).resolves.toStrictEqual([
      "https://one.sites.vm0.io",
      "https://two.sites.vm0.io",
    ]);
  });
});
