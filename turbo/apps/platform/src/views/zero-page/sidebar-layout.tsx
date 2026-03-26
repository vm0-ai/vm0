import type { ReactNode } from "react";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import { Button } from "@vm0/ui";
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

function GuestNavBar() {
  const setShowAboutPage = useSet(setZeroShowAboutPage$);

  return (
    <nav
      className="pointer-events-none absolute right-6 top-6 z-10"
      aria-label="Site links"
    >
      <div className="zero-float-card pointer-events-auto flex items-center gap-4 rounded-xl border border-border bg-card/95 px-4 py-2.5 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setShowAboutPage(true)}
          className="text-sm tracking-wide text-foreground hover:text-primary transition-colors duration-200"
        >
          About VM0
        </button>
        <a
          href="https://vm0.ai/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm tracking-wide text-foreground hover:text-primary transition-colors duration-200"
        >
          Pricing
        </a>
        <a href="/sign-in">
          <Button size="sm" className="h-9 rounded-lg px-4 text-sm font-medium">
            Sign in
          </Button>
        </a>
      </div>
    </nav>
  );
}

export function SidebarLayout({ children }: { children: ReactNode }) {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;

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
          onClick={() => setSidebarCollapsed(true)}
        />
      )}
      <div className="flex flex-1 flex-col min-w-0 min-h-0 zero-workspace-bg">
        {!isLoggedIn && <GuestNavBar />}
        {showAboutPage ? (
          <ZeroAboutPage onBack={() => setShowAboutPage(false)} />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
