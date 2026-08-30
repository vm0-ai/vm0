import { AuthV2ErrorAlert } from "./auth-v2-error-alert.tsx";

export function AuthV2FieldError({
  focusKey,
  id,
  message,
}: {
  readonly focusKey: string;
  readonly id: string;
  readonly message: string;
}) {
  return <AuthV2ErrorAlert focusKey={focusKey} id={id} message={message} />;
}
