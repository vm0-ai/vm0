import { useGet, useSet } from "ccstate-react";
import type { MouseEvent, Ref } from "react";
import { preserveLocalePathPrefix } from "../../i18n/locale-routing.ts";
import {
  detachedNavigateTo$,
  generateRouterPath,
  urlLocale$,
} from "../../signals/route.ts";

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
  ref,
  ...rest
}: LinkProps) {
  const navigate = useSet(detachedNavigateTo$);
  const urlLocale = useGet(urlLocale$);
  const path = generateRouterPath(pathname, options?.pathParams);
  const localizedPath = preserveLocalePathPrefix(
    path,
    location.hostname,
    urlLocale,
  );
  const href = buildHref(localizedPath, options?.searchParams, options?.hash);

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

  return (
    <a ref={ref} href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
