import { Card, CardContent, CardDescription, CardHeader } from "@okouai/ui";
import { useSet } from "ccstate-react";
import type { CSSProperties, ReactNode } from "react";

import { focusAuthV2HeadingRef$ } from "../../signals/auth-v2-presentation.ts";

const AUTH_V2_TITLE_ID = "auth-v2-title";
const AUTH_V2_DESCRIPTION_ID = "auth-v2-description";

function authV2PageActionSemantics(): CSSProperties &
  Record<`--${string}`, string> {
  return {
    "--color-primary": "var(--color-foreground)",
    "--color-primary-foreground": "var(--color-background)",
    "--color-primary-hover": "var(--color-foreground-hover)",
    "--color-primary-pressed": "var(--color-foreground-pressed)",
  };
}

interface AuthV2ShellProps {
  readonly announcement?: ReactNode;
  readonly children: ReactNode;
  readonly description: ReactNode;
  readonly focusKey: string;
  readonly footer?: ReactNode;
  readonly title: ReactNode;
}

export function AuthV2Shell({
  announcement,
  children,
  description,
  focusKey,
  footer,
  title,
}: AuthV2ShellProps) {
  const focusHeading = useSet(focusAuthV2HeadingRef$);

  return (
    <div
      className="w-full max-w-[25rem] space-y-4"
      style={authV2PageActionSemantics()}
    >
      <Card
        aria-describedby={AUTH_V2_DESCRIPTION_ID}
        aria-labelledby={AUTH_V2_TITLE_ID}
        className="relative w-full overflow-visible rounded-[12px] border-border shadow-none"
        data-testid="app-auth-v2"
        role="region"
        style={authV2PageActionSemantics()}
      >
        <CardHeader className="items-center bg-transparent px-5 pt-6 pb-2 text-center sm:px-10 sm:pt-7">
          <h1
            className="rounded-sm text-lg font-medium text-foreground outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            id={AUTH_V2_TITLE_ID}
            key={focusKey}
            ref={focusHeading}
            tabIndex={-1}
          >
            {title}
          </h1>
          <CardDescription
            className="max-w-sm leading-5"
            id={AUTH_V2_DESCRIPTION_ID}
          >
            {description}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-5 pt-4 pb-6 sm:px-10">
          {children}
        </CardContent>
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
