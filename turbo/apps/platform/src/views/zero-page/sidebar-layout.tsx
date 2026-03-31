import type { ReactNode } from "react";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import { IconMenu2 } from "@tabler/icons-react";
import { ZeroSidebar } from "./zero-sidebar.tsx";
import { user$ } from "../../signals/auth.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroShowAboutPage$,
  setZeroShowAboutPage$,
  zeroSidebarCollapsed$,
  setZeroSidebarCollapsed$,
} from "../../signals/zero-page/zero-nav.ts";
import { mobileBreadcrumb$ } from "../../signals/zero-page/zero-mobile-breadcrumb.ts";
import { ZeroAboutPage } from "./zero-about-page.tsx";
import { AppSkeleton } from "./app-skeleton.tsx";
import { Link } from "../router/link.tsx";

function SidebarLayoutSkeleton() {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;
  const agentNameLoadable = useLastLoadable(agentDisplayName$);
  const agentNameReady = agentNameLoadable.state === "hasData";
  const visible = isLoggedIn && !agentNameReady;

  return <AppSkeleton visible={visible} />;
}

function MobileTopBar() {
  const setSidebarCollapsed = useSet(setZeroSidebarCollapsed$);
  const breadcrumbLoadable = useLastLoadable(mobileBreadcrumb$);
  const breadcrumb =
    breadcrumbLoadable.state === "hasData" ? breadcrumbLoadable.data : null;

  return (
    <div className="md:hidden shrink-0 flex items-center h-12 px-3 gap-2 bg-background border-b border-border/50 z-10">
      <button
        type="button"
        onClick={() => setSidebarCollapsed(false)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        aria-label="Open menu"
      >
        <IconMenu2 size={18} stroke={1.8} />
      </button>
      {breadcrumb && (
        <div className="flex-1 min-w-0 text-sm text-muted-foreground flex items-center gap-1">
          <Link
            pathname={breadcrumb.sectionPath}
            className="hover:text-foreground transition-colors no-underline text-inherit"
          >
            {breadcrumb.section}
          </Link>
          {breadcrumb.name && (
            <>
              <span className="text-muted-foreground/40 select-none">/</span>
              <span className="text-foreground font-medium truncate">
                {breadcrumb.name}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SidebarLayoutInner({ children }: { children: ReactNode }) {
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
        <MobileTopBar />
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

export function SidebarLayout({ children }: { children: ReactNode }) {
  return <SidebarLayoutInner>{children}</SidebarLayoutInner>;
}
