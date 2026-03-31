import type { ReactNode } from "react";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import { ZeroSidebar } from "./zero-sidebar.tsx";
import { user$ } from "../../signals/auth.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroShowAboutPage$,
  setZeroShowAboutPage$,
  zeroSidebarCollapsed$,
  setZeroSidebarCollapsed$,
} from "../../signals/zero-page/zero-nav.ts";
import { ZeroAboutPage } from "./zero-about-page.tsx";
import { AppSkeleton } from "./app-skeleton.tsx";

function SidebarLayoutSkeleton() {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;
  const agentNameLoadable = useLastLoadable(agentDisplayName$);
  const agentNameReady = agentNameLoadable.state === "hasData";
  const visible = isLoggedIn && !agentNameReady;

  return <AppSkeleton visible={visible} />;
}

export function SidebarLayout({ children }: { children: ReactNode }) {
  const showAboutPage = useGet(zeroShowAboutPage$);
  const setShowAboutPage = useSet(setZeroShowAboutPage$);

  const sidebarCollapsed = useGet(zeroSidebarCollapsed$);
  const setSidebarCollapsed = useSet(setZeroSidebarCollapsed$);

  return (
    <div className="zero-app flex h-dvh w-full bg-background">
      <SidebarLayoutSkeleton />
      <ZeroSidebar />
      {!sidebarCollapsed && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => {
            return setSidebarCollapsed(true);
          }}
        />
      )}
      <div className="flex flex-1 flex-col min-w-0 min-h-0 zero-workspace-bg">
        {showAboutPage ? (
          <ZeroAboutPage
            onBack={() => {
              return setShowAboutPage(false);
            }}
          />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
