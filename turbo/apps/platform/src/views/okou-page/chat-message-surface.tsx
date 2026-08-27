import { cn } from "@okouai/ui";
import type { HTMLAttributes } from "react";

export const CHAT_THREAD_CONTENT_MAIN_CLASS =
  "items-center py-4 pl-4 pr-4 sm:pl-6 sm:pr-6 @container";

export const CHAT_THREAD_MESSAGE_LIST_CLASS =
  "w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4 overflow-visible";

export const CHAT_THREAD_USER_MESSAGE_ROW_CLASS =
  "flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start";

export const CHAT_THREAD_ASSISTANT_MESSAGE_GROUP_CLASS =
  "flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300";

export const CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS =
  "flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start";

export const CHAT_THREAD_USER_MESSAGE_ACTIONS_CLASS =
  "flex justify-end gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150";

export const CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_ROW_CLASS =
  "@[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px]";

export const CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_CLASS =
  "flex items-center justify-between pt-2 pb-1 gap-2 -ml-1";

// Consecutive user messages read as one burst. The copy button already sits
// `mt-1` below its message, so this pull keeps the gap below it equally tight.
export const CHAT_THREAD_MESSAGE_STACK_PULL_CLASS = "-mt-5";

export function ChatUserMessageBubble({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

export function ChatAssistantMessageBody({
  className,
  compactTop = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly compactTop?: boolean }) {
  return (
    <div
      className={cn(
        "zero-chat-bubble-assistant px-0 text-[0.9375rem] leading-[1.7] min-w-0 [overflow-wrap:anywhere]",
        compactTop ? "@[900px]:pt-0" : "@[900px]:pt-2.5",
        className,
      )}
      {...props}
    />
  );
}
