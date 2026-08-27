import { useSet } from "ccstate-react";
import type {
  FocusEvent,
  MouseEvent,
  PointerEvent,
  Ref,
  TouchEvent,
} from "react";
import {
  generateRouterPath,
  detachedNavigateTo$,
  prefetchRoute$,
} from "../../signals/route.ts";
import { bestEffort, detach, Reason } from "../../signals/utils.ts";

type PathName = Parameters<typeof generateRouterPath>[0];
type PathParams = Parameters<typeof generateRouterPath>[1];

interface NavigationOptions {
  pathParams?: PathParams;
  searchParams?: URLSearchParams;
  hash?: string;
}

function buildHref(
  path: string,
  searchParams?: URLSearchParams,
  hash?: string,
): string {
  const search = searchParams?.toString();
  const fragment = hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "";
  return `${search ? `${path}?${search}` : path}${fragment}`;
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
  onFocus,
  onPointerEnter,
  onTouchStart,
  ref,
  ...rest
}: LinkProps) {
  const navigate = useSet(detachedNavigateTo$);
  const prefetch = useSet(prefetchRoute$);
  const path = generateRouterPath(pathname, options?.pathParams);
  const href = buildHref(path, options?.searchParams, options?.hash);

  const prefetchOnIntent = () => {
    detach(
      bestEffort(prefetch(path)),
      Reason.DomCallback,
      "route intent prefetch",
    );
  };

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) {
      return;
    }
    e.preventDefault();

    if (isNewTabClick(e)) {
      window.open(`${window.location.origin}${href}`, "_blank");
    } else {
      navigate(pathname, options);
    }
  };

  const handleFocus = (e: FocusEvent<HTMLAnchorElement>) => {
    onFocus?.(e);
    if (!e.defaultPrevented) {
      prefetchOnIntent();
    }
  };

  const handlePointerEnter = (e: PointerEvent<HTMLAnchorElement>) => {
    onPointerEnter?.(e);
    if (!e.defaultPrevented) {
      prefetchOnIntent();
    }
  };

  const handleTouchStart = (e: TouchEvent<HTMLAnchorElement>) => {
    onTouchStart?.(e);
    if (!e.defaultPrevented) {
      prefetchOnIntent();
    }
  };

  return (
    <a
      ref={ref}
      href={href}
      onClick={handleClick}
      onFocus={handleFocus}
      onPointerEnter={handlePointerEnter}
      onTouchStart={handleTouchStart}
      {...rest}
    >
      {children}
    </a>
  );
}
