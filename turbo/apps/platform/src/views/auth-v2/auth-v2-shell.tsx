import { Card, CardContent, CardDescription, CardHeader } from "@okouai/ui";
import { useSet } from "ccstate-react";
import type { ReactNode } from "react";

import { focusAuthV2HeadingRef$ } from "../../signals/auth-v2-presentation.ts";

const AUTH_V2_TITLE_ID = "auth-v2-title";
const AUTH_V2_DESCRIPTION_ID = "auth-v2-description";

interface AuthV2ShellProps {
  readonly announcement?: ReactNode;
  readonly children: ReactNode;
  readonly description: ReactNode;
  readonly focusKey: string;
  readonly title: ReactNode;
}

export function AuthV2Shell({
  announcement,
  children,
  description,
  focusKey,
  title,
}: AuthV2ShellProps) {
  const focusHeading = useSet(focusAuthV2HeadingRef$);

  return (
    <Card
      aria-describedby={AUTH_V2_DESCRIPTION_ID}
      aria-labelledby={AUTH_V2_TITLE_ID}
      className="zero-composer relative w-full max-w-md overflow-visible"
      data-testid="app-auth-v2"
      role="region"
    >
      <CardHeader className="items-center bg-transparent px-5 pt-6 pb-2 text-center sm:px-6 sm:pt-7">
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
      <CardContent className="px-5 pt-4 pb-5 sm:px-6 sm:pb-6">
        {children}
      </CardContent>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="auth-v2-announcer"
      >
        {announcement}
      </p>
    </Card>
  );
}
