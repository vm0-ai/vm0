import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  cn,
} from "@okouai/ui";
import { useSet } from "ccstate-react";
import type { ReactNode } from "react";

import { focusAuthHeadingRef$ } from "../../signals/auth-presentation.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";

const AUTH_CARD_TITLE_ID = "auth-card-title";
const AUTH_CARD_DESCRIPTION_ID = "auth-card-description";

interface AuthCardShellProps {
  readonly announcement?: ReactNode;
  readonly cardFooter?: ReactNode;
  readonly children: ReactNode;
  readonly description?: ReactNode;
  readonly focusKey: string;
  readonly headerDetail?: ReactNode;
  readonly layout?: "choice" | "default";
  readonly surface?: "dialog" | "page";
  readonly title: ReactNode;
}

export function AuthCardShell({
  announcement,
  cardFooter,
  children,
  description,
  focusKey,
  headerDetail,
  layout = "default",
  surface = "page",
  title,
}: AuthCardShellProps) {
  const focusHeading = useSet(focusAuthHeadingRef$);
  const choiceLayout = layout === "choice";

  return (
    <div
      className={cn(
        "max-w-[25rem] shrink-0 space-y-4",
        surface === "dialog" ? "w-full" : "w-[calc(100%+0.5rem)]",
      )}
    >
      <Card
        aria-describedby={description ? AUTH_CARD_DESCRIPTION_ID : undefined}
        aria-labelledby={AUTH_CARD_TITLE_ID}
        className={cn(
          "relative w-full rounded-[12px] border-border p-0 shadow-none",
          choiceLayout && "overflow-hidden",
        )}
        data-testid="app-auth-card"
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
            <span className="mb-5" data-testid="auth-card-brand-logo">
              <ProductBrandMark decorative size="compact" />
            </span>
            <div className="w-full space-y-1">
              <h1
                className="text-lg font-medium text-foreground outline-none"
                id={AUTH_CARD_TITLE_ID}
                key={focusKey}
                ref={focusHeading}
                tabIndex={-1}
              >
                {title}
              </h1>
              {description ? (
                <CardDescription
                  className="max-w-sm leading-5"
                  id={AUTH_CARD_DESCRIPTION_ID}
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
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="auth-card-announcer"
      >
        {announcement}
      </p>
    </div>
  );
}
