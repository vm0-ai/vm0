import { command, state } from "ccstate";

/**
 * Holds the scroll container element for the chat thread page.
 * Set via ref callback in ZeroChatThreadPage.
 */
const chatScrollContainer$ = state<HTMLElement | null>(null);

export const setChatScrollContainer$ = command(
  ({ set }, el: HTMLElement | null) => {
    set(chatScrollContainer$, el);
  },
);

/**
 * Scroll the chat view so the latest message exchange is visible.
 *
 * Algorithm:
 * - If the last user + assistant message pair fits in the visible area,
 *   scroll so the user message is at the top.
 * - Otherwise scroll to the absolute bottom.
 *
 * The visible area is reduced by the sticky composer height so content
 * is not hidden behind it.
 */
export const autoScroll$ = command(({ get }) => {
  const scrollEl = get(chatScrollContainer$);
  if (!scrollEl) {
    return;
  }
  const container = scrollEl.querySelector<HTMLElement>(
    "[data-message-container]",
  );
  if (!container) {
    return;
  }

  const children = container.children;
  if (children.length === 0) {
    return;
  }

  let lastUser: HTMLElement | null = null;
  let lastAssistant: HTMLElement | null = null;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i] as HTMLElement;
    const role = child.dataset.role;
    if (!lastAssistant && role === "assistant") {
      lastAssistant = child;
    }
    if (!lastUser && role === "user") {
      lastUser = child;
    }
    if (lastUser && lastAssistant) {
      break;
    }
  }

  if (!lastUser) {
    return;
  }

  const composer = scrollEl.querySelector<HTMLElement>("[data-chat-composer]");
  const composerHeight = composer ? composer.offsetHeight : 0;
  const visibleHeight = scrollEl.clientHeight - composerHeight;
  const userTop = lastUser.offsetTop - container.offsetTop;

  if (lastAssistant && lastAssistant.offsetTop > lastUser.offsetTop) {
    const assistantBottom =
      lastAssistant.offsetTop -
      container.offsetTop +
      lastAssistant.offsetHeight;
    if (assistantBottom - userTop <= visibleHeight) {
      scrollEl.scrollTop = userTop;
    } else {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  } else {
    scrollEl.scrollTop = userTop;
  }
});
