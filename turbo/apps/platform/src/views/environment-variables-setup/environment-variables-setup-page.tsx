import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconLock, IconCheck } from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { theme$ } from "../../signals/theme.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  formValues$,
  formErrors$,
  updateFormValue$,
  submitForm$,
  submitPromise$,
  isSuccess$,
  connectorItems$,
  manualItems$,
  allConnectorsSatisfied$,
  autoSuccess$,
  type ConnectorItem,
} from "../../signals/environment-variables-setup/environment-variables-setup.ts";
import {
  connectConnector$,
  pollingConnectorType$,
} from "../../signals/settings-page/connectors.ts";
import { deleteConnector$ } from "../../signals/external/connectors.ts";
import { ConnectorIcon } from "../settings-page/connector-icons.tsx";

function LogoHeader() {
  const theme = useGet(theme$);

  return (
    <a href="/" className="flex items-center gap-2.5 p-1.5 shrink-0">
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
    </a>
  );
}

function SecurityFooter() {
  const theme = useGet(theme$);

  return (
    <div className="flex flex-col gap-1 items-center w-full">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground leading-4">
          Secured by
        </span>
        <img
          src={theme === "dark" ? "/logo_dark.svg" : "/logo_light.svg"}
          alt="VM0"
          className="block max-w-none"
          style={{ width: "50px", height: "15px" }}
        />
      </div>
      <p className="text-xs text-muted-foreground text-center leading-4">
        Your secrets are securely stored and never exposed directly to agents.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[540px] overflow-hidden rounded-xl border border-border bg-popover">
        <div className="flex flex-col items-center gap-8 p-10">
          <LogoHeader />
          <div className="flex flex-col gap-5 w-full">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-2 w-full">
                <div className="h-5 w-32 rounded bg-muted animate-pulse" />
                <div className="h-9 w-full rounded-lg bg-muted animate-pulse" />
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
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[540px] min-h-[380px] overflow-hidden rounded-xl border border-border bg-popover">
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

function ConnectorCard({ item }: { item: ConnectorItem }) {
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const disconnect = useSet(deleteConnector$);
  const pageSignal = useGet(pageSignal$);

  const isPolling = pollingType === item.connectorType;

  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 w-full">
      <ConnectorIcon type={item.connectorType} size={30} />
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <span className="text-sm font-medium text-foreground">
          {item.label}
        </span>
        <span className="hidden sm:inline text-sm text-muted-foreground">
          {item.helpText}
        </span>
      </div>
      {item.connected ? (
        <div className="flex items-center gap-1.5 shrink-0">
          <IconCheck
            size={16}
            stroke={2}
            className="text-emerald-600 dark:text-emerald-400"
          />
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => {
              detach(disconnect(item.connectorType), Reason.DomCallback);
            }}
            className="text-xs text-muted-foreground h-auto p-0"
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPolling}
          onClick={() => {
            detach(connect(item.connectorType, pageSignal), Reason.DomCallback);
          }}
          className="shrink-0"
        >
          {isPolling ? "Connecting..." : "Connect"}
        </Button>
      )}
    </div>
  );
}

function FormState() {
  const connectorItemsStatus = useLoadable(connectorItems$);
  const manualItemsStatus = useLoadable(manualItems$);
  const connectorsSatisfiedStatus = useLoadable(allConnectorsSatisfied$);
  const values = useGet(formValues$);
  const errors = useGet(formErrors$);
  const setFormValue = useSet(updateFormValue$);
  const submit = useSet(submitForm$);
  const submitStatus = useLoadable(submitPromise$);
  const pageSignal = useGet(pageSignal$);

  const connectors =
    connectorItemsStatus.state === "hasData" ? connectorItemsStatus.data : [];
  const manualItems =
    manualItemsStatus.state === "hasData" ? manualItemsStatus.data : [];
  const connectorsSatisfied =
    connectorsSatisfiedStatus.state === "hasData"
      ? connectorsSatisfiedStatus.data
      : false;
  const isSubmitting = submitStatus.state === "loading";
  const hasManualItems = manualItems.length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[540px] max-h-[min(90vh,800px)] overflow-hidden rounded-xl border border-border bg-popover flex flex-col">
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          {/* Fixed header */}
          <div className="shrink-0 flex flex-col items-center gap-8 px-10 pt-10">
            <LogoHeader />
            <div className="flex flex-col gap-1 items-center w-full">
              <h1 className="text-lg font-medium leading-7 text-foreground">
                VM0 would like to connect
              </h1>
              <p className="text-sm leading-5 text-muted-foreground text-center">
                Add the required secrets so your agent can run
              </p>
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 min-h-0 overflow-y-auto px-10 py-8">
            <div className="flex flex-col gap-5 w-full">
              {manualItems.map((item) => (
                <div key={item.name} className="flex flex-col gap-2 w-full">
                  <label className="text-sm font-medium leading-5 text-foreground px-1">
                    {item.name}
                  </label>
                  <div className="relative">
                    <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      <IconLock size={18} stroke={1.5} />
                    </div>
                    <Input
                      type={item.type === "secret" ? "password" : "text"}
                      value={values[item.name] ?? ""}
                      placeholder="Enter value"
                      onChange={(e) => setFormValue(item.name, e.target.value)}
                      readOnly={isSubmitting}
                      className={`pl-10 ${
                        errors[item.name]
                          ? "border-destructive focus:border-destructive focus:ring-destructive/10"
                          : ""
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

              {connectors.map((item) => (
                <ConnectorCard key={item.connectorType} item={item} />
              ))}
            </div>
          </div>

          {/* Fixed footer */}
          <div className="shrink-0 flex flex-col items-center gap-8 px-10 pb-10">
            {hasManualItems && (
              <div className="flex flex-col w-full">
                <Button
                  type="submit"
                  disabled={isSubmitting || !connectorsSatisfied}
                  size="sm"
                  className="w-full"
                >
                  {isSubmitting ? "Saving..." : "Verify"}
                </Button>
              </div>
            )}
            <SecurityFooter />
          </div>
        </form>
      </div>
    </div>
  );
}

export function EnvironmentVariablesSetupPage() {
  const success = useGet(isSuccess$);
  const autoSuccessStatus = useLoadable(autoSuccess$);
  const connectorItemsStatus = useLoadable(connectorItems$);
  const manualItemsStatus = useLoadable(manualItems$);

  if (success) {
    return <SuccessState />;
  }

  if (autoSuccessStatus.state === "hasData" && autoSuccessStatus.data) {
    return <SuccessState />;
  }

  const isLoading =
    connectorItemsStatus.state === "loading" ||
    manualItemsStatus.state === "loading";

  if (isLoading) {
    return <LoadingState />;
  }

  if (
    connectorItemsStatus.state === "hasData" &&
    manualItemsStatus.state === "hasData" &&
    connectorItemsStatus.data.length === 0 &&
    manualItemsStatus.data.length === 0
  ) {
    return <SuccessState />;
  }

  return <FormState />;
}
