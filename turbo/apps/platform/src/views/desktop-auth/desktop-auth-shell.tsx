import { Card, CardContent, CardDescription, CardHeader } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";

import {
  platformVm0LogoDarkImg,
  platformVm0LogoImg,
} from "../../lib/static-assets.ts";
import type { AuthBrandContext } from "../../signals/auth.ts";
import { focusDesktopAuthHeadingRef$ } from "../../signals/desktop-auth/desktop-auth-presentation.ts";
import { theme$ } from "../../signals/theme.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";

const DESKTOP_AUTH_TITLE_ID = "desktop-auth-title";
const DESKTOP_AUTH_DESCRIPTION_ID = "desktop-auth-description";

interface DesktopAuthShellProps {
  readonly announcement?: ReactNode;
  readonly authBrand: AuthBrandContext;
  readonly children: ReactNode;
  readonly description?: ReactNode;
  readonly focusKey: string;
  readonly title: ReactNode;
}

export function DesktopAuthShell({
  announcement,
  authBrand,
  children,
  description,
  focusKey,
  title,
}: DesktopAuthShellProps) {
  const focusHeading = useSet(focusDesktopAuthHeadingRef$);
  const theme = useGet(theme$);

  return (
    <div className="w-[calc(100%+0.5rem)] max-w-[25rem] shrink-0 space-y-4">
      <Card
        aria-describedby={description ? DESKTOP_AUTH_DESCRIPTION_ID : undefined}
        aria-labelledby={DESKTOP_AUTH_TITLE_ID}
        className="relative w-full rounded-[12px] border-border p-0 shadow-none"
        data-testid="app-desktop-auth"
        role="region"
      >
        <div className="flex flex-col gap-8 px-10 py-8">
          <CardHeader className="items-center space-y-0 bg-transparent p-0 text-center">
            {authBrand.brandName === "Okou" ? (
              <span className="mb-5" data-testid="desktop-auth-brand-logo">
                <ProductBrandMark
                  brandName={authBrand.brandName}
                  decorative
                  size="compact"
                />
              </span>
            ) : (
              <img
                alt=""
                aria-hidden="true"
                className="mb-5 h-5 w-auto"
                crossOrigin="anonymous"
                data-testid="desktop-auth-brand-logo"
                height={20}
                src={
                  theme === "dark" ? platformVm0LogoImg : platformVm0LogoDarkImg
                }
                width={82}
              />
            )}
            <div className="w-full space-y-1">
              <h1
                className="text-lg font-medium text-foreground outline-none"
                id={DESKTOP_AUTH_TITLE_ID}
                key={focusKey}
                ref={focusHeading}
                tabIndex={-1}
              >
                {title}
              </h1>
              {description ? (
                <CardDescription
                  className="max-w-sm leading-5"
                  id={DESKTOP_AUTH_DESCRIPTION_ID}
                >
                  {description}
                </CardDescription>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="p-0">{children}</CardContent>
        </div>
      </Card>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="desktop-auth-announcer"
      >
        {announcement}
      </p>
    </div>
  );
}
