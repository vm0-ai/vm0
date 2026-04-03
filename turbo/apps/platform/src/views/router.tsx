import { useGet } from "ccstate-react";
import { page$ } from "../signals/react-router.ts";
import { appSkeletonVisible$ } from "../signals/app-skeleton.ts";
import { AppSkeleton } from "./zero-page/app-skeleton.tsx";

export function Router() {
  const page = useGet(page$);
  const skeletonVisible = useGet(appSkeletonVisible$);

  return (
    <>
      {page ?? null}
      <AppSkeleton visible={!page || skeletonVisible} />
    </>
  );
}
