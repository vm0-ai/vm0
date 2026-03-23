import { useGet } from "ccstate-react";
import { page$ } from "../signals/react-router.ts";
import { AppSkeleton } from "./zero-page/app-skeleton.tsx";

export function Router() {
  const page = useGet(page$);

  if (!page) {
    return <AppSkeleton />;
  }

  return <>{page}</>;
}
