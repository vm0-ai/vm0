import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconLock, IconCheck } from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { theme$ } from "../../signals/theme.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  missingItems$,
  formValues$,
  formErrors$,
  updateFormValue$,
  submitForm$,
  submitPromise$,
  isSuccess$,
} from "../../signals/environment-variables-setup/environment-variables-setup.ts";

function StandaloneBackground() {
  return (
    <>
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.08)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.08)_1px,transparent_1px)] bg-[size:3rem_3rem]" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#FFC8B0]/20 via-[#A6DEFF]/15 to-[#FFE7A2]/20 blur-3xl" />
      <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-[#FFC8B0]/15 blur-3xl" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-[#A6DEFF]/10 blur-3xl" />
      <div className="absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-[#FFE7A2]/15 blur-3xl" />
    </>
  );
}

function LogoHeader() {
  const theme = useGet(theme$);

  return (
    <div className="flex items-center gap-2.5 shrink-0">
      <div className="inline-grid grid-cols-[max-content] grid-rows-[max-content] items-start justify-items-start leading-[0] shrink-0">
        <img
          src={theme === "dark" ? "/logo_dark.svg" : "/logo_light.svg"}
          alt="VM0"
          className="col-1 row-1 block max-w-none"
          style={{ width: "81px", height: "24px" }}
        />
      </div>
      <p className="text-2xl font-normal leading-8 text-foreground shrink-0">
        Platform
      </p>
    </div>
  );
}

function SecurityFooter() {
  const theme = useGet(theme$);

  return (
    <div className="flex flex-col gap-1 items-center w-full">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Secured by</span>
        <img
          src={theme === "dark" ? "/logo_dark.svg" : "/logo_light.svg"}
          alt="VM0"
          className="block max-w-none"
          style={{ width: "50px", height: "15px" }}
        />
      </div>
      <p className="text-xs text-muted-foreground text-center">
        Your secrets are securely stored and never exposed directly to agents.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-6 overflow-hidden">
      <StandaloneBackground />
      <div className="relative z-10 w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col items-center gap-8 p-10">
          <LogoHeader />
          <div className="flex flex-col gap-5 w-full">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-2 w-full">
                <div className="h-5 w-32 rounded bg-muted animate-pulse" />
                <div className="h-9 w-full rounded-md bg-muted animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SuccessState() {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-6 overflow-hidden">
      <StandaloneBackground />
      <div className="relative z-10 w-full max-w-[400px] min-h-[380px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col items-center p-10">
          <LogoHeader />
          <div className="mt-12 flex flex-col items-center gap-4">
            <IconCheck size={40} className="text-lime-600" stroke={1} />
            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-lg font-medium leading-7 text-foreground">
                Your secrets are configured.
              </h1>
              <p className="text-sm leading-5 text-muted-foreground">
                Close this window and return to your terminal.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FormState() {
  const missingItemsStatus = useLoadable(missingItems$);
  const values = useGet(formValues$);
  const errors = useGet(formErrors$);
  const setFormValue = useSet(updateFormValue$);
  const submit = useSet(submitForm$);
  const submitStatus = useLoadable(submitPromise$);
  const pageSignal = useGet(pageSignal$);

  const items =
    missingItemsStatus.state === "hasData" ? missingItemsStatus.data : [];
  const isSubmitting = submitStatus.state === "loading";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-6 overflow-hidden">
      <StandaloneBackground />
      <div className="relative z-10 w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
        <form
          onSubmit={handleSubmit}
          className="flex flex-col items-center gap-8 p-10"
        >
          <LogoHeader />

          <div className="flex flex-col items-center w-full">
            <div className="flex flex-col gap-1 items-center w-full">
              <h1 className="text-lg font-medium leading-7 text-foreground">
                VM0 would like to connect
              </h1>
              <p className="text-sm leading-5 text-muted-foreground text-center">
                Add the required secrets so your agent can run
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-5 w-full">
            {items.map((item) => (
              <div key={item.name} className="flex flex-col gap-2 w-full">
                <label className="text-sm font-medium text-foreground px-1">
                  {item.name}
                </label>
                <div className="relative">
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    <IconLock size={16} />
                  </div>
                  <input
                    type={item.type === "secret" ? "password" : "text"}
                    value={values[item.name] ?? ""}
                    placeholder="Enter value"
                    onChange={(e) => setFormValue(item.name, e.target.value)}
                    readOnly={isSubmitting}
                    className={`h-9 w-full rounded-md border bg-input pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50 ${
                      errors[item.name] ? "border-destructive" : "border-border"
                    }`}
                  />
                </div>
                {errors[item.name] && (
                  <p className="text-xs text-destructive px-1">
                    {errors[item.name]}
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-col w-full">
            <Button
              type="submit"
              disabled={isSubmitting}
              className="w-full h-9"
            >
              {isSubmitting ? "Saving..." : "Verify"}
            </Button>
          </div>

          <SecurityFooter />
        </form>
      </div>
    </div>
  );
}

export function EnvironmentVariablesSetupPage() {
  const success = useGet(isSuccess$);
  const missingItemsStatus = useLoadable(missingItems$);

  if (success) {
    return <SuccessState />;
  }

  if (missingItemsStatus.state === "loading") {
    return <LoadingState />;
  }

  if (
    missingItemsStatus.state === "hasData" &&
    missingItemsStatus.data.length === 0
  ) {
    return <SuccessState />;
  }

  return <FormState />;
}
