import type { ReactNode } from "react";
import { useGet } from "ccstate-react";
import { page$, pageLayout$ } from "../signals/react-router.ts";
import { appSkeletonVisible$ } from "../signals/app-skeleton.ts";
import { AppSkeleton } from "./zero-page/app-skeleton.tsx";
import { InspectLogFileInput } from "./inspect-log-file-input.tsx";
import { SidebarLayout } from "./zero-page/sidebar-layout.tsx";
import { MinimalSidebarLayout } from "./zero-page/zero-directed-shared.tsx";

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

function AppSkeletonOverlay() {
  const page = useGet(page$);
  const skeletonVisible = useGet(appSkeletonVisible$);
  return <AppSkeleton visible={!page || skeletonVisible} />;
}

export function Router() {
  return (
    <>
      <LayoutHost>
        <PageSlot />
      </LayoutHost>
      <AppSkeletonOverlay />
      <InspectLogFileInput />
    </>
  );
}
