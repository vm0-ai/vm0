import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

interface ThinkingMessagesProps {
  messages: readonly { readonly id: string; readonly text: string }[];
  fallback?: ReactNode;
  intervalMs?: number;
  className?: string;
}

function ThinkingMessages({
  messages,
  fallback,
  intervalMs = 3000,
  className,
}: ThinkingMessagesProps) {
  const [currentId, setCurrentId] = useState(messages[0]?.id);
  const advance = useEffectEvent(() => {
    setCurrentId((id) => {
      const index = Math.max(
        0,
        messages.findIndex((message) => {
          return message.id === id;
        }),
      );
      return messages[(index + 1) % messages.length]?.id;
    });
  });

  useEffect(() => {
    if (messages.length < 2) {
      return;
    }
    const timer = window.setInterval(advance, intervalMs);
    return () => {
      return window.clearInterval(timer);
    };
  }, [intervalMs, messages.length]);

  const current =
    messages.find((message) => {
      return message.id === currentId;
    }) ?? messages[0];
  return (
    <span
      className={cn("block min-w-0 truncate", className)}
      aria-label={current?.text}
    >
      {current?.text ?? fallback}
    </span>
  );
}

export { ThinkingMessages, type ThinkingMessagesProps };
