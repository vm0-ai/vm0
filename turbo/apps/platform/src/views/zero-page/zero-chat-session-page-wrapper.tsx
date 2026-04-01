import { SidebarLayout } from "./sidebar-layout.tsx";
import { ZeroChatThreadPage } from "./zero-chat-thread-page.tsx";

export function ZeroChatSessionPageWrapper() {
  return (
    <SidebarLayout>
      <ZeroChatThreadPage />
    </SidebarLayout>
  );
}
