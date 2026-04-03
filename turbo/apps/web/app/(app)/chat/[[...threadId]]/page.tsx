"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useChat } from "ai/react";
import { toast } from "sonner";

import { useLocalStorage } from "@/app/lib/hooks/use-local-storage";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/app/components/ui/resizable";
import { Sidebar } from "@/app/components/Sidebar";
import { ChatMessages } from "@/app/components/ChatMessages";
import { ChatPanel } from "@/app/components/ChatPanel";
import { EmptyScreen } from "@/app/components/EmptyScreen";
import { ChatScrollAnchor } from "@/app/components/ChatScrollAnchor";
import { StopButton } from "@/app/components/StopButton";
import { useNewChat } from "@/app/lib/hooks/use-new-chat";
import { useAgent } from "@/app/lib/hooks/use-agent";

export default function ChatPage({
  params,
}: {
  params: { threadId?: string[] };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { userId } = useAuth();
  const { agent } = useAgent();
  const threadId = params.threadId?.[0];
  const [newChatId, setNewChatId] = useNewChat();
  const isNewChat = !threadId;

  const {
    messages,
    append,
    reload,
    stop,
    isLoading,
    input,
    setInput,
    setMessages,
  } = useChat({
    api: "/api/chat",
    id: threadId,
    body: {
      agentId: agent?.id,
    },
    onResponse(response) {
      if (response.status === 401) {
        toast.error(response.statusText);
      }
    },
    onFinish() {
      if (isNewChat && messages.length > 0 && !newChatId) {
        const newId = messages[0].id;
        setNewChatId(newId);
        router.push(`/chat/${newId}`);
        router.refresh();
      }
    },
  });

  const [_, setNewChatDialog] = useLocalStorage("show-new-chat-dialog", true);

  useEffect(() => {
    if (!userId) {
      router.push("/sign-in");
      return;
    }
    if (isNewChat) {
      setMessages([]);
      setNewChatId(null);
    }
  }, [pathname, userId, isNewChat, setMessages, router, setNewChatId]);

  return (
    <ResizablePanelGroup direction="horizontal">
      <ResizablePanel defaultSize={20} minSize={15} maxSize={25}>
        <Sidebar />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel>
        <div className="flex h-full flex-col">
          <div className="relative flex h-full w-full flex-1 flex-col items-center overflow-hidden">
            <div className="relative h-full w-full flex-1 overflow-y-scroll">
              <ChatScrollAnchor trackVisibility={isLoading} />
              {messages.length ? (
                <ChatMessages messages={messages} />
              ) : (
                <EmptyScreen />
              )}
            </div>
            <div className="w-full max-w-2xl px-4">
              <div className="relative mb-4 mt-2 flex h-auto items-center">
                <StopButton
                  onClick={stop}
                  show={isLoading && messages.length > 0}
                />
                <ChatPanel
                  isLoading={isLoading}
                  append={append}
                  input={input}
                  setInput={setInput}
                />
              </div>
            </div>
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
