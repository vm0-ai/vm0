import { useGet, useSet } from "ccstate-react";
import type { MouseEvent, Ref } from "react";
import {
  generateRouterPath,
  detachedNavigateTo$,
} from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";

type PathName = Parameters<typeof generateRouterPath>[0];
type PathParams = Parameters<typeof generateRouterPath>[1];

interface NavigationOptions {
  pathParams?: PathParams;
  searchParams?: URLSearchParams;
}

function buildHref(path: string, searchParams?: URLSearchParams): string {
  const search = searchParams?.toString();
  return search ? `${path}?${search}` : path;
}

function isNewTabClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey;
}

// ---------------------------------------------------------------------------
// Link component
// ---------------------------------------------------------------------------

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  pathname: PathName;
  options?: NavigationOptions;
  ref?: Ref<HTMLAnchorElement>;
}

export function Link({
  pathname,
  options,
  children,
  onClick,
  ref,
  ...rest
}: LinkProps) {
  const navigate = useSet(detachedNavigateTo$);
  const { signal: rootSignal } = useGet(rootSignal$);
  const path = generateRouterPath(pathname, options?.pathParams);
  const href = buildHref(path, options?.searchParams);

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) {
      return;
    }
    e.preventDefault();

    if (isNewTabClick(e)) {
      window.open(`${window.location.origin}${href}`, "_blank");
    } else {
      detach(navigate(pathname, options, rootSignal), Reason.DomCallback);
    }
  };

  return (
    <a ref={ref} href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
