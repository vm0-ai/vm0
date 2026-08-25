import { Alert, AlertDescription } from "@okouai/ui/components/ui/alert";

export function AuthV2ErrorAlert({
  focusKey,
  message,
}: {
  readonly focusKey: string;
  readonly message: string;
}) {
  return (
    <Alert
      aria-atomic="true"
      className="outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
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
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
