import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@okouai/ui";
import { useSet } from "ccstate-react";
import type { ReactNode } from "react";

import { focusAuthV2HeadingRef$ } from "../../signals/auth-v2-presentation.ts";

const AUTH_V2_TITLE_ID = "auth-v2-title";
const AUTH_V2_DESCRIPTION_ID = "auth-v2-description";

interface AuthV2ShellProps {
  readonly announcement?: ReactNode;
  readonly cardFooter?: ReactNode;
  readonly children: ReactNode;
  readonly description?: ReactNode;
  readonly focusKey: string;
  readonly footer?: ReactNode;
  readonly headerDetail?: ReactNode;
  readonly title: ReactNode;
}

export function AuthV2Shell({
  announcement,
  cardFooter,
  children,
  description,
  focusKey,
  footer,
  headerDetail,
  title,
}: AuthV2ShellProps) {
  const focusHeading = useSet(focusAuthV2HeadingRef$);

  return (
    <div className="w-[calc(100%+0.5rem)] max-w-[25rem] shrink-0 space-y-4">
      <Card
        aria-describedby={description ? AUTH_V2_DESCRIPTION_ID : undefined}
        aria-labelledby={AUTH_V2_TITLE_ID}
        className="relative w-full rounded-[12px] border-border p-0 shadow-none"
        data-testid="app-auth-v2"
        role="region"
      >
        <div className="flex flex-col gap-8 px-10 py-8">
          <CardHeader className="items-center space-y-1 bg-transparent p-0 text-center">
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
          </CardHeader>
          <CardContent className="p-0">{children}</CardContent>
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
