import { afterEach, describe, expect, it } from "vitest";
import { clickAdjacentSidebarThread } from "../chat-sidebar-dom.ts";

function appendSidebarLink(
  root: HTMLElement,
  {
    id,
    selected = "",
  }: {
    id: string;
    selected?: "" | "main" | "side";
  },
) {
  const link = root.ownerDocument.createElement("a");
  link.href = `/chats/${id}`;
  link.dataset.chatThreadId = id;
  link.dataset.selected = selected;
  let lastClick: MouseEvent | null = null;
  link.addEventListener("click", (event) => {
    lastClick = event as MouseEvent;
  });
  root.append(link);
  return {
    link,
    lastClick: () => {
      return lastClick;
    },
  };
}

describe("clickAdjacentSidebarThread", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("clicks the adjacent main thread in DOM order", () => {
    const root = document.createElement("div");
    document.body.append(root);
    appendSidebarLink(root, { id: "previous" });
    appendSidebarLink(root, { id: "current", selected: "main" });
    const side = appendSidebarLink(root, { id: "side", selected: "side" });
    const next = appendSidebarLink(root, { id: "next" });

    expect(clickAdjacentSidebarThread(root, "main", "next")).toBeTruthy();

    expect(side.lastClick()).toBeNull();
    expect(next.lastClick()).toBeInstanceOf(MouseEvent);
    expect(next.lastClick()?.altKey).toBeFalsy();
  });

  it("dispatches alt-click when moving the side thread", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const previous = appendSidebarLink(root, { id: "previous" });
    const main = appendSidebarLink(root, { id: "main", selected: "main" });
    appendSidebarLink(root, { id: "side", selected: "side" });
    appendSidebarLink(root, { id: "next" });

    expect(clickAdjacentSidebarThread(root, "side", "prev")).toBeTruthy();

    expect(main.lastClick()).toBeNull();
    expect(previous.lastClick()).toBeInstanceOf(MouseEvent);
    expect(previous.lastClick()?.altKey).toBeTruthy();
  });
});
