import { useLayoutEffect } from "react";
import { useLastResolved } from "ccstate-react";
import type { AssistantChatMessage } from "../../signals/zero-page/zero-chat.ts";

function scrollToLatestMessage() {
  const scrollEl = document.querySelector<HTMLElement>(
    "[data-scroll-container]",
  );
  const container = document.querySelector<HTMLElement>(
    "[data-message-container]",
  );
  if (!scrollEl || !container) {
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

  const visibleHeight = scrollEl.clientHeight;
  const userTop = lastUser.offsetTop - container.offsetTop;

  if (lastAssistant && lastAssistant.offsetTop > lastUser.offsetTop) {
    const assistantBottom =
      lastAssistant.offsetTop -
      container.offsetTop +
      lastAssistant.offsetHeight;
    if (assistantBottom - userTop <= visibleHeight) {
      scrollEl.scrollTop = userTop;
    } else {
      scrollEl.scrollTop = assistantBottom - visibleHeight;
    }
  } else {
    scrollEl.scrollTop = userTop;
  }
}

export function useMessageAnchor(message: AssistantChatMessage) {
  const content = useLastResolved(message.result$) ?? "";
  useLayoutEffect(() => {
    scrollToLatestMessage();
  }, [content]);
}
