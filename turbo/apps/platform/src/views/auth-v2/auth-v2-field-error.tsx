export function AuthV2FieldError({
  focusKey,
  id,
  message,
}: {
  readonly focusKey: string;
  readonly id: string;
  readonly message: string;
}) {
  return (
    <p
      aria-atomic="true"
      className="rounded-sm text-xs leading-4 text-red-600 outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 dark:text-red-400"
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
      role="alert"
      tabIndex={-1}
    >
      {message}
    </p>
  );
}
