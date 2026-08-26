import { Alert, AlertDescription } from "@okouai/ui/components/ui/alert";

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
      className="px-3 py-2 text-xs text-red-700 outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 dark:text-red-300"
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
      <AlertDescription className="text-xs leading-4">
        {message}
      </AlertDescription>
    </Alert>
  );
}
