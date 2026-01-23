import { useGet } from "ccstate-react";
import { page$ } from "../signals/react-router.ts";

export function Router() {
  const page = useGet(page$);

  return <>{page}</>;
}
