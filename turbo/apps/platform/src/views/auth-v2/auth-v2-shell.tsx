import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  cn,
} from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";

import {
  platformVm0LogoDarkImg,
  platformVm0LogoImg,
} from "../../lib/static-assets.ts";
import { focusAuthV2HeadingRef$ } from "../../signals/auth-v2-presentation.ts";
import type { AuthBrandContext } from "../../signals/auth.ts";
import { theme$ } from "../../signals/theme.ts";

const AUTH_V2_TITLE_ID = "auth-v2-title";
const AUTH_V2_DESCRIPTION_ID = "auth-v2-description";

interface AuthV2ShellProps {
  readonly announcement?: ReactNode;
  readonly authBrand: AuthBrandContext;
  readonly cardFooter?: ReactNode;
  readonly children: ReactNode;
  readonly description?: ReactNode;
  readonly focusKey: string;
  readonly footer?: ReactNode;
  readonly headerDetail?: ReactNode;
  readonly layout?: "choice" | "default";
  readonly title: ReactNode;
}

export function AuthV2Shell({
  announcement,
  authBrand,
  cardFooter,
  children,
  description,
  focusKey,
  footer,
  headerDetail,
  layout = "default",
  title,
}: AuthV2ShellProps) {
  const focusHeading = useSet(focusAuthV2HeadingRef$);
  const theme = useGet(theme$);
  const choiceLayout = layout === "choice";

  return (
    <div className="w-[calc(100%+0.5rem)] max-w-[25rem] shrink-0 space-y-4">
      <Card
        aria-describedby={description ? AUTH_V2_DESCRIPTION_ID : undefined}
        aria-labelledby={AUTH_V2_TITLE_ID}
        className={cn(
          "relative w-full rounded-[12px] border-border p-0 shadow-none",
          choiceLayout && "overflow-hidden",
        )}
        data-testid="app-auth-v2"
        role="region"
      >
        <div
          className={cn(
            "flex flex-col",
            choiceLayout ? "" : "gap-8 px-10 py-8",
          )}
        >
          <CardHeader
            className={cn(
              "items-center space-y-0 bg-transparent p-0 text-center",
              choiceLayout && "px-10 py-8",
            )}
          >
            {authBrand.brandName === "VM0" ? (
              <img
                alt=""
                aria-hidden="true"
                className="mb-5 h-5 w-auto"
                crossOrigin="anonymous"
                data-testid="auth-v2-brand-logo"
                height={20}
                src={
                  theme === "dark" ? platformVm0LogoImg : platformVm0LogoDarkImg
                }
                width={82}
              />
            ) : null}
            <div className="w-full space-y-1">
              <h1
                className="text-lg font-medium text-foreground outline-none"
                id={AUTH_V2_TITLE_ID}
                key={focusKey}
                ref={focusHeading}
                tabIndex={-1}
              >
                {title}
              </h1>
              {description ? (
                <CardDescription
                  className="max-w-sm leading-5"
                  id={AUTH_V2_DESCRIPTION_ID}
                >
                  {description}
                </CardDescription>
              ) : null}
              {headerDetail}
            </div>
          </CardHeader>
          <CardContent
            className={cn("p-0", choiceLayout && "border-t border-border")}
          >
            {children}
          </CardContent>
        </div>
        {cardFooter ? (
          <CardFooter className="justify-center border-t border-border px-10 py-4">
            {cardFooter}
          </CardFooter>
        ) : null}
      </Card>
      {footer ? <div className="space-y-1">{footer}</div> : null}
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="auth-v2-announcer"
      >
        {announcement}
      </p>
    </div>
  );
}
