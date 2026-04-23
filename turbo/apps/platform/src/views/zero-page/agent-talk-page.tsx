import { useGet, useLastResolved } from "ccstate-react";
import type { VoiceChatTask } from "@vm0/core/contracts/zero-voice-chat";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  currentChatAgentId$,
  currentChatAgentDisplayName$,
} from "../../signals/agent-chat.ts";
import { Markdown } from "../components/markdown.tsx";
import {
  vccStatus$,
  vccError$,
} from "../../signals/voice-chat-candidate/voice-chat-candidate-session.ts";
import {
  lastUserMessage$,
  lastAgentMessage$,
  agentChatPendingTasks$,
} from "../../signals/zero-page/agent-chat-voice-mode.ts";
import {
  ChatAgentAvatar,
  ChatHeaderAction,
  VoiceChatLauncher,
} from "./agent-chat-page.tsx";

function TaskRow({ task }: { task: VoiceChatTask }) {
  const latestProgress = task.assistantMessages.at(-1)?.content.trim() ?? "";
  const showProgress = latestProgress.length > 0;
  return (
    <li
      className="text-foreground"
      data-testid="voice-task-row"
      data-task-status={task.status}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="shrink-0 h-2 w-2 rounded-full bg-sky-600 animate-pulse"
          aria-label="Running"
        />
        <span
          className="font-medium truncate min-w-0"
          data-testid={
            showProgress ? "voice-task-row-progress" : "voice-task-row-prompt"
          }
        >
          {showProgress ? latestProgress : task.prompt}
        </span>
      </div>
    </li>
  );
}

function VoiceModeSubtitle() {
  const userContent = useGet(lastUserMessage$);
  const agentContent = useGet(lastAgentMessage$);
  return (
    <div className="w-full flex flex-col gap-2" data-testid="voice-subtitle">
      <p
        className="text-sm text-muted-foreground line-clamp-1 min-h-[1.25rem]"
        data-testid="voice-subtitle-user"
      >
        {userContent}
      </p>
      <div
        className="text-base text-foreground min-h-[1.5rem]"
        data-testid="voice-subtitle-agent"
      >
        {agentContent ? <Markdown source={agentContent} /> : null}
      </div>
    </div>
  );
}

function VoiceModeTaskList() {
  // Async computed — `useLastResolved` keeps the previous list visible while
  // the next Ably-triggered fetch is in flight, avoiding a flash to empty.
  const tasks = useLastResolved(agentChatPendingTasks$) ?? [];
  if (tasks.length === 0) {
    return null;
  }
  return (
    <ul className="w-full space-y-2 text-sm" data-testid="voice-task-list">
      {tasks.map((task: VoiceChatTask) => {
        return <TaskRow key={task.id} task={task} />;
      })}
    </ul>
  );
}

function voiceStatusText(
  status: "idle" | "connecting" | "connected" | "disconnected" | "error",
  agentName: string,
  hasError: boolean,
): string {
  if (hasError || status === "error") {
    return "Error";
  }
  if (status === "connecting" || status === "idle") {
    return "Connecting…";
  }
  return `${agentName} is online`;
}

export function AgentTalkPage() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const currentChatAgentDisplayName = useLastResolved(
    currentChatAgentDisplayName$,
  );
  const pageSignal = useGet(pageSignal$);
  const vccStatus = useGet(vccStatus$);
  const vccError = useGet(vccError$);

  const statusText = voiceStatusText(
    vccStatus,
    currentChatAgentDisplayName ?? "Agent",
    vccError !== null,
  );

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-2">
        <div className="flex justify-end items-center gap-2">
          <ChatHeaderAction pageSignal={pageSignal} />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-[900px] flex flex-col items-stretch gap-6 pt-8 pb-12 sm:pt-[20vh] sm:pb-[10vh]">
          <div className="flex items-center gap-4 w-full">
            <ChatAgentAvatar agentId={currentChatAgentId} />
            <div className="flex-1 min-w-0 flex items-center gap-3">
              <VoiceChatLauncher />
              <h2
                aria-label={statusText}
                data-testid="chat-tagline"
                className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground"
              >
                {statusText}
              </h2>
            </div>
          </div>

          <VoiceModeSubtitle />
          <VoiceModeTaskList />
        </div>
      </main>
    </div>
  );
}
