import { Button, cn } from "@okouai/ui";
import { Loader2 } from "lucide-react";
import type {
  ComponentProps,
  FormEvent,
  MouseEventHandler,
  ReactNode,
} from "react";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { AUTH_V2_LINK_ACTION_CLASS } from "./auth-v2-action-styles.ts";

export function AuthV2LoadingStep({
  copy,
}: {
  readonly copy: { readonly loading: string };
}) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2 className="animate-spin" aria-hidden="true" />
      <span>{copy.loading}</span>
    </div>
  );
}

export function AuthV2CompleteStep() {
  return (
    <div
      className="flex flex-col items-center gap-3 py-8 text-center"
      role="status"
    >
      <Loader2
        className="animate-spin text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}

export function AuthV2SwitchLink({
  children,
  className,
  href,
  pathname,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly href: string;
  readonly pathname: ComponentProps<typeof Link>["pathname"];
}) {
  const url = new URL(href, location.origin);
  return (
    <Link
      className={className}
      options={{ hash: url.hash, searchParams: url.searchParams }}
      pathname={pathname}
    >
      {children}
    </Link>
  );
}

export function AuthV2BackLink({
  children,
  disabled,
  onClick,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <Button
      className={cn(
        "mx-auto h-auto w-fit p-0 text-sm leading-5",
        AUTH_V2_LINK_ACTION_CLASS,
      )}
      disabled={disabled}
      type="button"
      variant="link"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function authV2SubmitHandler(
  run: () => unknown,
  description: string,
): (event: FormEvent<HTMLFormElement>) => void {
  return (event) => {
    event.preventDefault();
    detach(run(), Reason.DomCallback, description);
  };
}
