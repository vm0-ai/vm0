import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { UsagePage } from "./usage-page.tsx";

export function ZeroUsagePageWrapper() {
  return (
    <SidebarLayout>
      <UsagePage />
    </SidebarLayout>
  );
}
