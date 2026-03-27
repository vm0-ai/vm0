import { useSet } from "ccstate-react";
import type { MouseEvent, Ref } from "react";
import { generateRouterPath, navigateTo$ } from "../../signals/route.ts";

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
  const navigate = useSet(navigateTo$);
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
      navigate(pathname, options);
    }
  };

  return (
    <a ref={ref} href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
