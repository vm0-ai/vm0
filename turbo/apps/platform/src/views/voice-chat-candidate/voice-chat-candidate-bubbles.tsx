import { IconInfoCircle, IconSparkles } from "@tabler/icons-react";
import type { VoiceChatCandidateItem, VoiceChatCandidateTask } from "@vm0/core";
import { Markdown } from "../components/markdown.tsx";

// ---------------------------------------------------------------------------
// Bubble components — one per VoiceChatCandidateItem role
// ---------------------------------------------------------------------------

export function VoiceCandidateUserBubble({ content }: { content: string }) {
  if (!content.trim()) {
    return null;
  }
  return (
    <div className="flex justify-end">
      <div className="zero-chat-bubble-user rounded-xl max-w-[85%] px-4 py-3 text-sm leading-relaxed break-words overflow-hidden">
        <Markdown source={content} />
      </div>
    </div>
  );
}

export function VoiceCandidateAssistantBubble({
  content,
}: {
  content: string;
}) {
  if (!content.trim()) {
    return null;
  }
  return (
    <div className="flex justify-start">
      <div className="zero-chat-bubble-assistant rounded-xl max-w-[85%] px-4 py-3 text-sm leading-relaxed break-words overflow-hidden">
        <Markdown source={content} />
      </div>
    </div>
  );
}

export function VoiceCandidateTaskResultBubble({
  prompt,
  result,
  error,
}: {
  prompt: string | null;
  result: string | null;
  error: string | null;
}) {
  return (
    <div className="flex justify-start">
      <div className="rounded-xl max-w-[85%] bg-muted/60 border border-border px-4 py-3 text-sm leading-relaxed">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
          <IconSparkles size={14} />
          Task result
        </div>
        {prompt && (
          <p className="text-xs text-muted-foreground mb-2 break-words">
            {prompt}
          </p>
        )}
        {error ? (
          <div className="text-destructive break-words">{error}</div>
        ) : (
          result && (
            <div className="break-words">
              <Markdown source={result} />
            </div>
          )
        )}
      </div>
    </div>
  );
}

export function VoiceCandidateSystemNoteBubble({
  content,
}: {
  content: string;
}) {
  return (
    <div className="flex justify-center">
      <div className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs italic text-muted-foreground">
        <IconInfoCircle size={12} />
        <span className="break-words">{content}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function VoiceCandidateItemBubble({
  item,
  taskById,
}: {
  item: VoiceChatCandidateItem;
  taskById: Record<string, VoiceChatCandidateTask>;
}) {
  switch (item.role) {
    case "user": {
      return <VoiceCandidateUserBubble content={item.content ?? ""} />;
    }
    case "assistant": {
      return <VoiceCandidateAssistantBubble content={item.content ?? ""} />;
    }
    case "task_result": {
      const task = item.taskId ? taskById[item.taskId] : undefined;
      return (
        <VoiceCandidateTaskResultBubble
          prompt={task?.prompt ?? null}
          result={item.content ?? task?.result ?? null}
          error={task?.error ?? null}
        />
      );
    }
    case "system_note": {
      return <VoiceCandidateSystemNoteBubble content={item.content ?? ""} />;
    }
  }
}
