import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { page$, pageLayout$ } from "../signals/react-router.ts";
import {
  appSkeletonOverlayMounted$,
  appSkeletonVisible$,
  bootstrapSkeletonActive$,
  firstAppContentVisibleEventRef$,
  unmountAppSkeletonOverlay$,
} from "../signals/app-skeleton.ts";
import { AppSkeleton } from "./okou-page/app-skeleton.tsx";
import { SidebarLayout } from "./okou-page/sidebar-layout.tsx";
import { MinimalSidebarLayout } from "./okou-page/directed-shared.tsx";

function PageSlot() {
  const page = useGet(page$);
  const skeletonVisible = useGet(appSkeletonVisible$);
  const firstContentVisibleEventRef = useSet(firstAppContentVisibleEventRef$);

  return (
    <>
      {page ?? null}
      {page !== undefined && !skeletonVisible ? (
        <span ref={firstContentVisibleEventRef} hidden />
      ) : null}
    </>
  );
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
  const unmountAppSkeletonOverlay = useSet(unmountAppSkeletonOverlay$);
  const visible = !bootstrapSkeletonActive && (!page || skeletonVisible);

  if (!mounted || bootstrapSkeletonActive) {
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
