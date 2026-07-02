export type SidebarThreadPane = "main" | "side";

function sidebarThreadLinks(root: HTMLElement): HTMLAnchorElement[] {
  return Array.from(
    root.ownerDocument.querySelectorAll<HTMLAnchorElement>(
      "a[data-chat-thread-id]",
    ),
  );
}

function sidebarLinkThreadId(link: HTMLAnchorElement): string | null {
  return link.dataset.chatThreadId ?? null;
}

function sidebarLinkTitle(link: HTMLAnchorElement): string | null {
  return link.dataset.chatThreadTitle ?? null;
}

function selectedSidebarThreadLink(
  root: HTMLElement,
  pane: SidebarThreadPane,
): HTMLAnchorElement | null {
  return (
    sidebarThreadLinks(root).find((link) => {
      return link.dataset.selected === pane;
    }) ?? null
  );
}

export function sidebarThreadTitleForPane(
  root: HTMLElement,
  pane: SidebarThreadPane | null,
  threadId: string,
): string | null | undefined {
  const selectedLink = pane ? selectedSidebarThreadLink(root, pane) : null;
  if (selectedLink && sidebarLinkThreadId(selectedLink) === threadId) {
    return sidebarLinkTitle(selectedLink);
  }
  const matchingLink = sidebarThreadLinks(root).find((link) => {
    return sidebarLinkThreadId(link) === threadId;
  });
  return matchingLink ? sidebarLinkTitle(matchingLink) : undefined;
}

function dispatchSidebarThreadClick(
  root: HTMLElement,
  link: HTMLAnchorElement,
  pane: SidebarThreadPane,
): void {
  link.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: root.ownerDocument.defaultView,
      altKey: pane === "side",
    }),
  );
}

export function clickAdjacentSidebarThread(
  root: HTMLElement,
  pane: SidebarThreadPane,
  direction: "prev" | "next",
): boolean {
  const selectedLink = selectedSidebarThreadLink(root, pane);
  if (!selectedLink) {
    return false;
  }
  const otherPane: SidebarThreadPane = pane === "main" ? "side" : "main";
  const links = sidebarThreadLinks(root).filter((link) => {
    return link.dataset.selected !== otherPane;
  });
  const currentIndex = links.indexOf(selectedLink);
  if (currentIndex === -1) {
    return false;
  }
  const targetIndex =
    direction === "prev" ? currentIndex - 1 : currentIndex + 1;
  const targetLink = links[targetIndex];
  if (!targetLink) {
    return false;
  }
  dispatchSidebarThreadClick(root, targetLink, pane);
  return true;
}
