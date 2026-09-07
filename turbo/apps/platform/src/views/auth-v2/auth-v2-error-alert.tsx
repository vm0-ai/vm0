import { cn } from "@okouai/ui";
import { Alert, AlertDescription } from "@okouai/ui/components/ui/alert";
import {
  AUTH_ERROR_ALERT_CLASS,
  AUTH_ERROR_ALERT_TEXT_CLASS,
} from "../auth/auth-action-styles.ts";

export function AuthV2ErrorAlert({
  focusKey,
  id,
  message,
}: {
  readonly focusKey: string;
  readonly id?: string;
  readonly message: string;
}) {
  return (
    <Alert
      aria-atomic="true"
      className={cn(AUTH_ERROR_ALERT_CLASS, AUTH_ERROR_ALERT_TEXT_CLASS)}
      id={id}
      ref={(element) => {
        if (!element || element.dataset.authV2ErrorFocusKey === focusKey) {
          return;
        }
        element.dataset.authV2ErrorFocusKey = focusKey;
        queueMicrotask(() => {
          if (
            element.isConnected &&
            element.dataset.authV2ErrorFocusKey === focusKey
          ) {
            element.focus({ preventScroll: true });
          }
        });
      }}
      tabIndex={-1}
      variant="destructive"
    >
      <AlertDescription className={AUTH_ERROR_ALERT_TEXT_CLASS}>
        {message}
      </AlertDescription>
    </Alert>
  );
}
