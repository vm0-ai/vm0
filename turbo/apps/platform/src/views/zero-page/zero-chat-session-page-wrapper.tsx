import { useGet } from "ccstate-react";
import { chatThreadId$ } from "../../signals/zero-page/zero-nav.ts";
import { SidebarLayout } from "./sidebar-layout.tsx";
import { ZeroChatThreadPage } from "./zero-chat-thread-page.tsx";

export function ZeroChatSessionPageWrapper() {
  const chatThreadId = useGet(chatThreadId$);
  if (!chatThreadId) {
    return null;
  }
  return (
    <SidebarLayout>
      <ZeroChatThreadPage key={chatThreadId} />
    </SidebarLayout>
  );
}
