import { describe, it, expect } from "vitest";
import { createStore } from "ccstate";
import { updateDocumentTitle$ } from "../document-title.ts";

describe("updateDocumentTitle$", () => {
  it("should set document.title with the page name and VM0 suffix", () => {
    const store = createStore();
    store.set(updateDocumentTitle$, "Team");
    expect(document.title).toBe("Team | VM0");
  });

  it("should update correctly when called multiple times", () => {
    const store = createStore();
    store.set(updateDocumentTitle$, "Team");
    expect(document.title).toBe("Team | VM0");

    store.set(updateDocumentTitle$, "Chat");
    expect(document.title).toBe("Chat | VM0");
  });
});
