import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { page$, pageLayout$ } from "../signals/react-router.ts";
import {
  appSkeletonOverlayMounted$,
  appSkeletonVisible$,
  bootstrapSkeletonActive$,
  bootstrapSkeletonTipsContainer$,
  mainStylesheetLoaded$,
  unmountAppSkeletonOverlay$,
} from "../signals/app-skeleton.ts";
import { AppSkeleton } from "./okou-page/app-skeleton.tsx";
import { AppLoadingTips } from "./okou-page/app-loading-tips.tsx";
import { SidebarLayout } from "./okou-page/sidebar-layout.tsx";
import { MinimalSidebarLayout } from "./okou-page/directed-shared.tsx";

function PageSlot() {
  const page = useGet(page$);
  return page ?? null;
}

function LayoutHost({ children }: { children: ReactNode }) {
  const layout = useGet(pageLayout$);
  if (layout === "sidebar") {
    return <SidebarLayout>{children}</SidebarLayout>;
  }
  if (layout === "minimal") {
    return <MinimalSidebarLayout>{children}</MinimalSidebarLayout>;
  }
  return <>{children}</>;
}

export function AppSkeletonOverlay() {
  const page = useGet(page$);
  const mounted = useGet(appSkeletonOverlayMounted$);
  const skeletonVisible = useGet(appSkeletonVisible$);
  const bootstrapSkeletonActive = useGet(bootstrapSkeletonActive$);
  const bootstrapTipsContainer = useGet(bootstrapSkeletonTipsContainer$);
  const stylesheetLoaded = useLastResolved(mainStylesheetLoaded$);
  const unmountAppSkeletonOverlay = useSet(unmountAppSkeletonOverlay$);
  const visible = !bootstrapSkeletonActive && (!page || skeletonVisible);

  if (bootstrapSkeletonActive) {
    return bootstrapTipsContainer && stylesheetLoaded
      ? createPortal(<AppLoadingTips />, bootstrapTipsContainer)
      : null;
  }

  if (!mounted) {
    return null;
  }

  return <AppSkeleton visible={visible} onHidden={unmountAppSkeletonOverlay} />;
}

export function Router() {
  return (
    <>
      <LayoutHost>
        <PageSlot />
      </LayoutHost>
    </>
  );
}
