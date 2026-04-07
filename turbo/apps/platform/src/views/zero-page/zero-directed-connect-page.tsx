import type { ReactNode } from "react";
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  allConnectorTypes$,
  connectConnector$,
  justConnectedTypes$,
  pollingConnectorType$,
  submitApiToken$,
  tokenFormSubmitting$,
  setTokenFormValue$,
  clearTokenForm$,
  tokenFormValuesFor$,
  setTokenFormSubmitting$,
} from "../../signals/zero-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  directedConnectType$,
  tokenDialogOpen$,
  setTokenDialogOpen$,
} from "../../signals/connectors-page/directed-connect-type.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { handleZeroAccountAction$ } from "../../signals/zero-page/zero-nav.ts";
import {
  orgManageDialogOpen$,
  setOrgManageDialogOpen$,
} from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { OrgManageDialog } from "./components/org-manage/org-manage-dialog.tsx";
import { ZeroOrgSwitcher } from "./zero-org-switcher.tsx";
import { AccountDropdown } from "./zero-sidebar.tsx";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import { Link } from "../router/link.tsx";

function MinimalSidebarLayout({ children }: { children: ReactNode }) {
  const onAccountAction = useSet(handleZeroAccountAction$);
  const dialogOpen = useGet(orgManageDialogOpen$);
  const setDialogOpen = useSet(setOrgManageDialogOpen$);
  const pageSignal = useGet(pageSignal$);

  return (
    <div className="zero-app flex h-dvh w-full bg-background">
      <OrgManageDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          detach(setDialogOpen(open, pageSignal), Reason.DomCallback);
        }}
      />
      <VM0ClerkProvider>
        <aside className="zero-nav hidden md:flex h-full w-[255px] shrink-0 flex-col bg-sidebar">
          <div className="shrink-0 px-2 pt-1.5">
            <ZeroOrgSwitcher />
          </div>
          <div className="flex-1" />
          <div className="p-2">
            <AccountDropdown onAccountAction={onAccountAction} />
          </div>
        </aside>
      </VM0ClerkProvider>
      <div className="flex flex-1 flex-col min-w-0 min-h-0 zero-workspace-bg">
        {children}
      </div>
    </div>
  );
}

function Vm0Logo() {
  return (
    <svg
      width="82"
      height="20"
      viewBox="0 0 100 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="VM0"
    >
      <path
        d="M13.3915 0.0627979C13.2455 -0.0209506 13.0657 -0.020839 12.9198 0.0630906L1.0053 6.91543C0.692394 7.09539 0.690093 7.54442 1.00114 7.72755L12.9156 14.7423C13.0636 14.8295 13.2475 14.8296 13.3957 14.7426L25.3445 7.72785C25.6562 7.54485 25.6539 7.09497 25.3404 6.91514L13.3915 0.0627979Z"
        fill="#ED4E01"
      />
      <path
        d="M0.710495 8.33374L12.6479 15.2595C12.7944 15.3445 12.8846 15.5015 12.8846 15.6715L12.8843 29.5237C12.8843 29.8899 12.4897 30.1187 12.1741 29.9356L0.236691 23.0096C0.0902206 22.9246 -3.46036e-06 22.7676 0 22.5977L0.00028208 8.74568C0.000289537 8.37949 0.394855 8.15064 0.710495 8.33374Z"
        fill="#ED4E01"
      />
      <path
        d="M24.947 21.6772C24.947 21.9507 24.8017 22.2036 24.5655 22.3415L16.2103 27.219C15.6975 27.5184 15.0533 27.1485 15.0533 26.5547L15.0531 16.7842C15.0531 16.5107 15.1983 16.2578 15.4345 16.1199L23.7897 11.2425C24.3025 10.9431 24.9468 11.313 24.9468 11.9068L24.947 21.6772ZM13.6541 16.3426V29.5279C13.6541 29.8852 14.0308 30.1106 14.3391 29.9444L14.3538 29.9362L25.5769 23.3654C26.25 22.9808 26.3462 22.6924 26.3459 22.1188L26.3459 8.93378C26.3459 8.57084 25.9572 8.344 25.6462 8.52548L14.4231 15.0001C14.0385 15.2885 13.6539 15.577 13.6541 16.3426Z"
        fill="#ED4E01"
      />
      <path
        d="M25.9616 10.58L15.2113 28.4616L14.2308 27.8817L24.981 10.0001L25.9616 10.58Z"
        fill="#ED4E01"
      />
      <path
        d="M42.1865 25L34.3459 5H37.4651L43.7887 21.4575L50.1264 5H53.2315L45.3908 25H42.1865Z"
        fill="currentColor"
      />
      <path
        d="M66.9877 25L59.4023 10.3417V25H56.4957V5H59.6716L67.413 20.0628L75.1686 5H78.3304V25H75.438V10.3417L67.8526 25H66.9877Z"
        fill="currentColor"
      />
      <path
        d="M99.3459 22.1409C99.3459 22.5314 99.2703 22.9033 99.1191 23.2566C98.9678 23.6007 98.7599 23.9028 98.4952 24.1632C98.2305 24.4235 97.9186 24.6281 97.5594 24.7768C97.2097 24.9256 96.8363 25 96.4393 25H86.2735C85.8765 25 85.4984 24.9256 85.1392 24.7768C84.7894 24.6281 84.4822 24.4235 84.2176 24.1632C83.9529 23.9028 83.745 23.6007 83.5937 23.2566C83.4425 22.9033 83.3669 22.5314 83.3669 22.1409V7.85914C83.3669 7.46862 83.4425 7.10135 83.5937 6.75732C83.745 6.404 83.9529 6.10181 84.2176 5.85077C84.4822 5.59042 84.7894 5.38587 85.1392 5.2371C85.4984 5.07903 85.8765 5 86.2735 5H96.4393C96.8363 5 97.2097 5.07903 97.5594 5.2371C97.9186 5.38587 98.2305 5.59042 98.4952 5.85077C98.7599 6.10181 98.9678 6.404 99.1191 6.75732C99.2703 7.10135 99.3459 7.46862 99.3459 7.85914V22.1409ZM86.2735 7.85914V22.1409H96.4393V7.85914H86.2735Z"
        fill="currentColor"
      />
      <path
        d="M94.8994 6.79107L97.1494 8.06891L87.8973 23.8325L85.6473 22.5547L94.8994 6.79107Z"
        fill="currentColor"
      />
    </svg>
  );
}

function renderMarkdown(text: string): string {
  return text
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary underline">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function ApiTokenForm({
  type,
  onSuccess,
}: {
  type: ConnectorType;
  onSuccess: () => void;
}) {
  const apiTokenConfig = CONNECTOR_TYPES[type].authMethods["api-token"];
  const submit = useSet(submitApiToken$);
  const setFormValue = useSet(setTokenFormValue$);
  const clearForm = useSet(clearTokenForm$);
  const pageSignal = useGet(pageSignal$);
  const secretValues = useGet(tokenFormValuesFor$(type));
  const submittingType = useGet(tokenFormSubmitting$);
  const setSubmitting = useSet(setTokenFormSubmitting$);
  const submitting = submittingType === type;

  if (!apiTokenConfig) {
    return null;
  }

  const secretEntries = Object.entries(apiTokenConfig.secrets);
  const allFilled = secretEntries.every(([name, cfg]) => {
    return !cfg.required || secretValues[name];
  });

  const handleSubmit = () => {
    if (!allFilled || submitting) {
      return;
    }
    setSubmitting(type);
    detach(
      (async () => {
        await submit(type, secretValues, pageSignal);
        setSubmitting(null);
        clearForm(type);
        onSuccess();
      })().catch(() => {
        setSubmitting(null);
      }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex w-full flex-col gap-3 text-left">
      {apiTokenConfig.helpText && (
        <div
          className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(apiTokenConfig.helpText),
          }}
        />
      )}
      {secretEntries.map(([name, secretConfig]) => {
        return (
          <div key={name} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {secretConfig.label}
            </label>
            <Input
              type="password"
              placeholder={secretConfig.placeholder}
              value={secretValues[name] ?? ""}
              onChange={(e) => {
                return setFormValue(type, name, e.target.value);
              }}
            />
          </div>
        );
      })}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!allFilled || submitting}
        className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-[10px] bg-[#ed4e01] text-sm font-medium text-white transition-colors hover:bg-[#d35400] disabled:opacity-60"
      >
        {submitting && <IconLoader2 size={14} className="animate-spin" />}
        {submitting ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

function ApiTokenDialog({
  type,
  open,
  onOpenChange,
}: {
  type: ConnectorType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const config = CONNECTOR_TYPES[type];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon type={type} size={20} />
            <DialogTitle>{config.label}</DialogTitle>
          </div>
        </DialogHeader>
        <ApiTokenForm
          type={type}
          onSuccess={() => {
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function DirectedConnectCard() {
  const type = useGet(directedConnectType$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const signal = useGet(pageSignal$);
  const justConnected = useGet(justConnectedTypes$);
  const allLoadable = useLastLoadable(allConnectorTypes$);
  const tokenDialogOpen = useGet(tokenDialogOpen$);
  const setTokenDialogOpen = useSet(setTokenDialogOpen$);

  if (!type || !(type in CONNECTOR_TYPES)) {
    return null;
  }

  const connectorType = type as ConnectorType;
  const config = CONNECTOR_TYPES[connectorType];
  const isConnecting = pollingType === connectorType;
  const isLoading =
    !justConnected.has(connectorType) && allLoadable.state === "loading";
  const isConnected =
    justConnected.has(connectorType) ||
    (allLoadable.state === "hasData" &&
      allLoadable.data.some((c) => {
        return c.type === connectorType && c.connected;
      }));

  const item =
    allLoadable.state === "hasData"
      ? allLoadable.data.find((c) => {
          return c.type === connectorType;
        })
      : null;

  const hasOAuth = item
    ? item.availableAuthMethods.includes("oauth")
    : "oauth" in config.authMethods;

  const handleConnect = () => {
    if (hasOAuth) {
      detach(connect(connectorType, signal), Reason.DomCallback);
    } else {
      setTokenDialogOpen(true);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto flex w-[430px] max-w-[calc(100%-48px)] flex-col items-center gap-12 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
          <Link pathname="/connectors" className="no-underline text-foreground">
            <Vm0Logo />
          </Link>
          <div className="flex w-full flex-col gap-4">
            <div className="flex flex-col items-center gap-2.5">
              {isLoading ? (
                <IconLoader2
                  size={20}
                  className="animate-spin text-muted-foreground"
                />
              ) : (
                <>
                  <h1 className="text-lg font-medium text-foreground">
                    {isConnected
                      ? `${config.label} connected`
                      : `Zero needs ${config.label} to proceed`}
                  </h1>
                  <div className="flex items-center justify-center rounded-[10px] bg-muted p-2.5">
                    <ConnectorIcon type={connectorType} size={20} />
                  </div>
                  <p className="w-60 text-sm text-muted-foreground">
                    {config.helpText}
                  </p>
                </>
              )}
            </div>
            {!isLoading && (
              <div className="flex items-center justify-center">
                {isConnected ? (
                  <div className="inline-flex h-9 w-[100px] items-center justify-center gap-1.5 text-sm font-medium text-emerald-600">
                    <IconCheck size={16} />
                    Connected
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={isConnecting}
                    onClick={handleConnect}
                    className="inline-flex h-9 w-[100px] items-center justify-center gap-2 rounded-[10px] bg-[#ed4e01] text-sm font-medium text-white transition-colors hover:bg-[#d35400] disabled:opacity-60"
                  >
                    {isConnecting && (
                      <IconLoader2 size={14} className="animate-spin" />
                    )}
                    {isConnecting ? "Connecting..." : "Connect"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <ApiTokenDialog
        type={connectorType}
        open={tokenDialogOpen}
        onOpenChange={setTokenDialogOpen}
      />
    </>
  );
}

export function ZeroDirectedConnectPage() {
  return (
    <MinimalSidebarLayout>
      <DirectedConnectCard />
    </MinimalSidebarLayout>
  );
}
