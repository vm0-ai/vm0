import {
  IconCheck,
  IconLoader2,
  IconMoon,
  IconSun,
  IconX,
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import { setTheme$, theme$ } from "../../signals/theme.ts";
import { VM0Logo } from "../components/vm0-logo.tsx";

type ConnectorCallbackPageStatus = "loading" | "success" | "error";

export function ZeroConnectorCallbackPage({
  connectorLabel,
  status,
  username,
  errorMessage,
}: {
  readonly connectorLabel: string;
  readonly status: ConnectorCallbackPageStatus;
  readonly username: string | null;
  readonly errorMessage: string | null;
}): React.JSX.Element {
  const theme = useGet(theme$);
  const setTheme = useSet(setTheme$);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <button
        type="button"
        onClick={() => {
          setTheme(theme === "dark" ? "light" : "dark");
        }}
        className="fixed right-6 top-6 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-muted"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
      </button>

      <div className="min-h-[380px] w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col items-center p-10">
          <div className="mb-8 flex items-center gap-2">
            <VM0Logo />
            <span className="text-2xl text-foreground">Platform</span>
          </div>

          <div
            className="mt-4 flex flex-col items-center gap-4"
            aria-live="polite"
          >
            {status === "success" ? (
              <IconCheck size={40} className="text-lime-600" stroke={1} />
            ) : status === "error" ? (
              <IconX size={40} className="text-red-500" stroke={1} />
            ) : (
              <IconLoader2
                size={40}
                className="animate-spin text-muted-foreground"
                stroke={1}
              />
            )}

            <div className="flex flex-col items-center gap-2 text-center">
              {status === "success" ? (
                <>
                  <h1 className="text-lg font-medium leading-7 text-foreground">
                    {connectorLabel} connected successfully.
                  </h1>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {username ? (
                      <>
                        Connected as <strong>{username}</strong>.
                      </>
                    ) : (
                      "Your account has been connected."
                    )}{" "}
                    You can close this tab now.
                  </p>
                </>
              ) : status === "error" ? (
                <>
                  <h1 className="text-lg font-medium leading-7 text-foreground">
                    {connectorLabel} connection failed.
                  </h1>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {errorMessage || "An error occurred during connection."}{" "}
                    Please close this window and try again.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="text-lg font-medium leading-7 text-foreground">
                    Connecting {connectorLabel}…
                  </h1>
                  <p className="text-sm leading-5 text-muted-foreground">
                    Please wait while we finish connecting your account.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
