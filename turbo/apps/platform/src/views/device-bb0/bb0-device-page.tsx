import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconBluetooth,
  IconCheck,
  IconChevronDown,
  IconLoader2,
  IconPlugConnected,
  IconRefresh,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { cn } from "@vm0/ui";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  BB0_PROVISIONING_SERVICE_UUID,
  bb0BrowserSupport$,
  bb0CanConfirmCode$,
  bb0CanSendWifi$,
  bb0DeviceCodeInput$,
  bb0DeviceInfo$,
  bb0ProvisioningState$,
  bb0WifiPassword$,
  bb0WifiSsid$,
  confirmBb0DeviceCode$,
  connectBb0Device$,
  disconnectBb0Device$,
  refreshBb0DeviceStatus$,
  resetBb0Onboarding$,
  sendBb0WifiCredentials$,
  setBb0DeviceCodeInput$,
  setBb0WifiPassword$,
  setBb0WifiSsid$,
} from "../../signals/device-bb0-page/bb0-device-onboarding.ts";

type StepStatus = "pending" | "active" | "complete";

function LoadingIcon({ visible }: { readonly visible: boolean }) {
  if (!visible) {
    return null;
  }
  return <IconLoader2 size={16} className="animate-spin" />;
}

function loadableErrorMessage(loadable: {
  readonly state: string;
  readonly error?: unknown;
}): string | null {
  if (loadable.state !== "hasError") {
    return null;
  }
  return loadable.error instanceof Error
    ? loadable.error.message
    : "bb0 setup failed.";
}

function StepError({ message }: { readonly message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

function StatusPill({
  tone,
  icon,
  children,
}: {
  readonly tone: "neutral" | "success";
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium zero-badge",
        tone === "success" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function StepBadge({
  number,
  status,
}: {
  readonly number: string;
  readonly status: StepStatus;
}) {
  if (status === "complete") {
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-primary">
        <IconCheck size={14} stroke={2} />
      </div>
    );
  }
  if (status === "active") {
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
        {number}
      </div>
    );
  }
  return (
    <div className="zero-badge flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-muted-foreground">
      {number}
    </div>
  );
}

function StepCard({
  number,
  status,
  title,
  description,
  statusPill,
  children,
}: {
  readonly number: string;
  readonly status: StepStatus;
  readonly title: string;
  readonly description: string;
  readonly statusPill?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="zero-card p-5">
      <div className="flex items-start gap-3">
        <StepBadge number={number} status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            {statusPill}
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function PageHeader({
  statusLabel,
  statusTone,
}: {
  readonly statusLabel: string;
  readonly statusTone: "neutral" | "success";
}) {
  return (
    <header className="px-4 pt-10 pb-4 sm:px-6">
      <div className="mx-auto max-w-[900px]">
        <StatusPill
          tone={statusTone}
          icon={
            <IconPlugConnected
              size={12}
              stroke={1.8}
              className={
                statusTone === "success"
                  ? "text-green-600"
                  : "text-muted-foreground"
              }
            />
          }
        >
          {statusLabel}
        </StatusPill>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          Set up bb0
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Connect over Bluetooth, send Wi-Fi, then enter the device code shown
          on bb0. After that, bb0 finishes setup by polling the API over Wi-Fi.
        </p>
      </div>
    </header>
  );
}

function UnsupportedBrowser({ reason }: { readonly reason: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">
      <header className="px-4 pt-10 pb-4 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <StatusPill
            tone="neutral"
            icon={
              <IconBluetooth
                size={12}
                stroke={1.8}
                className="text-muted-foreground"
              />
            }
          >
            Web Bluetooth required
          </StatusPill>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
            bb0 setup needs Web Bluetooth
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Open this page in a Chromium-based browser over HTTPS or localhost.
            The page is blocked before provisioning because bb0 setup depends on{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              navigator.bluetooth
            </code>
            .
          </p>
        </div>
      </header>
      <main className="px-4 pb-14 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <section className="zero-card flex items-start gap-3 p-5">
            <div className="zero-badge flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground">
              <IconBluetooth size={14} stroke={1.8} />
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              {reason ?? "Web Bluetooth is not available in this browser."}
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}

function BleConnectStep({ status }: { readonly status: StepStatus }) {
  const info = useGet(bb0DeviceInfo$);
  const state = useGet(bb0ProvisioningState$);
  const pageSignal = useGet(pageSignal$);
  const [connectLoadable, connect] = useLoadableSet(connectBb0Device$);
  const disconnect = useSet(disconnectBb0Device$);
  const connecting = connectLoadable.state === "loading";
  const connected = state.connectionStatus === "connected";
  const error = loadableErrorMessage(connectLoadable);

  const statusPill = connected ? (
    <StatusPill
      tone="success"
      icon={<IconCheck size={12} stroke={2} className="text-green-600" />}
    >
      Connected to {info.name ?? "bb0"}
    </StatusPill>
  ) : null;

  return (
    <StepCard
      number="1"
      status={status}
      title="Connect bb0"
      description="Put bb0 into setup mode, then choose the nearby Zero-Buddy device."
      statusPill={statusPill}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={connecting || connected}
            onClick={() => {
              detach(
                connect({ acceptAllDevices: false }, pageSignal),
                Reason.DomCallback,
                "connectBb0Device",
              );
            }}
          >
            <LoadingIcon visible={connecting} />
            {connected ? "Connected" : "Connect bb0"}
          </Button>
          {connected ? (
            <Button
              variant="outline"
              disabled={connecting}
              onClick={() => {
                disconnect();
              }}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
        <details className="group text-xs text-muted-foreground">
          <summary className="inline-flex cursor-pointer items-center gap-1 select-none hover:text-foreground">
            <IconChevronDown
              size={12}
              stroke={1.8}
              className="transition-transform group-open:rotate-180"
            />
            Show technical details
          </summary>
          <div className="zero-border mt-2 rounded-lg bg-gray-50 px-3 py-2 leading-6">
            Browser filter:{" "}
            <code className="text-foreground">Zero-Buddy-*</code>
            <br />
            Service UUID:{" "}
            <code className="break-all text-foreground">
              {BB0_PROVISIONING_SERVICE_UUID}
            </code>
          </div>
        </details>
      </div>
      <StepError message={error} />
    </StepCard>
  );
}

function WifiStep({ status }: { readonly status: StepStatus }) {
  const state = useGet(bb0ProvisioningState$);
  const ssid = useGet(bb0WifiSsid$);
  const password = useGet(bb0WifiPassword$);
  const canSendWifi = useGet(bb0CanSendWifi$);
  const pageSignal = useGet(pageSignal$);
  const setSsid = useSet(setBb0WifiSsid$);
  const setPassword = useSet(setBb0WifiPassword$);
  const [refreshLoadable, refresh] = useLoadableSet(refreshBb0DeviceStatus$);
  const [wifiLoadable, sendWifi] = useLoadableSet(sendBb0WifiCredentials$);
  const connected = state.connectionStatus === "connected";
  const refreshing = refreshLoadable.state === "loading";
  const sendingWifi = wifiLoadable.state === "loading";
  const error =
    loadableErrorMessage(wifiLoadable) ?? loadableErrorMessage(refreshLoadable);

  const statusPill = state.wifiSent ? (
    <StatusPill
      tone="success"
      icon={<IconCheck size={12} stroke={2} className="text-green-600" />}
    >
      Wi-Fi sent
    </StatusPill>
  ) : null;

  return (
    <StepCard
      number="2"
      status={status}
      title="Send Wi-Fi"
      description="Write Wi-Fi credentials over BLE. bb0 closes Bluetooth after receiving them."
      statusPill={statusPill}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Wi-Fi SSID
          <Input
            value={ssid}
            disabled={!connected || sendingWifi || state.wifiSent}
            placeholder="Zero-Lab"
            onChange={(event) => {
              setSsid(event.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Wi-Fi password
          <Input
            type="password"
            value={password}
            disabled={!connected || sendingWifi || state.wifiSent}
            placeholder="Leave empty for open network"
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={!canSendWifi || sendingWifi || state.wifiSent}
          onClick={() => {
            detach(
              sendWifi(pageSignal),
              Reason.DomCallback,
              "sendBb0WifiCredentials",
            );
          }}
        >
          <LoadingIcon visible={sendingWifi} />
          {state.wifiSent ? "Wi-Fi sent" : "Send Wi-Fi"}
        </Button>
        <Button
          variant="outline"
          disabled={!connected || refreshing || state.wifiSent}
          onClick={() => {
            detach(
              refresh(pageSignal),
              Reason.DomCallback,
              "refreshBb0DeviceStatus",
            );
          }}
        >
          <LoadingIcon visible={refreshing} />
          <IconRefresh size={16} />
          Refresh BLE status
        </Button>
      </div>
      {state.wifiSent ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Check the bb0 screen — the device will connect to Wi-Fi and display a
          code.
        </p>
      ) : null}
      <StepError message={error} />
    </StepCard>
  );
}

function DeviceCodeStep({ status }: { readonly status: StepStatus }) {
  const state = useGet(bb0ProvisioningState$);
  const deviceCode = useGet(bb0DeviceCodeInput$);
  const canConfirm = useGet(bb0CanConfirmCode$);
  const pageSignal = useGet(pageSignal$);
  const setDeviceCode = useSet(setBb0DeviceCodeInput$);
  const [confirmLoadable, confirmCode] = useLoadableSet(confirmBb0DeviceCode$);
  const confirming = confirmLoadable.state === "loading";
  const confirmed = state.operationStatus === "confirmed";
  const error = loadableErrorMessage(confirmLoadable);

  const statusPill = confirmed ? (
    <StatusPill
      tone="success"
      icon={<IconCheck size={12} stroke={2} className="text-green-600" />}
    >
      Code confirmed
    </StatusPill>
  ) : null;

  return (
    <StepCard
      number="3"
      status={status}
      title="Enter device code"
      description="Read the code from bb0's screen and confirm it here."
      statusPill={statusPill}
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Device code
        <Input
          value={deviceCode}
          disabled={confirming || confirmed}
          placeholder="ABCD-2345"
          inputMode="text"
          autoCapitalize="characters"
          onChange={(event) => {
            setDeviceCode(event.target.value);
          }}
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={!canConfirm || confirming}
          onClick={() => {
            detach(
              confirmCode(pageSignal),
              Reason.DomCallback,
              "confirmBb0DeviceCode",
            );
          }}
        >
          <LoadingIcon visible={confirming} />
          {confirmed ? "Code confirmed" : "Confirm code"}
        </Button>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        {confirmed
          ? "bb0 will receive its token and thread ID through its own Wi-Fi polling flow."
          : "This page does not send a PAT to the device. It only approves the visible code for your current account."}
      </p>
      <StepError message={error} />
    </StepCard>
  );
}

function ResetHelp() {
  const resetPage = useSet(resetBb0Onboarding$);

  return (
    <section className="zero-card p-5">
      <div className="flex items-start gap-3">
        <div className="zero-badge flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground">
          <IconRefresh size={14} stroke={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">
            Something went wrong?
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Hold <code className="text-foreground">BtnA</code>, press{" "}
            <code className="text-foreground">BtnB</code> once, then release{" "}
            <code className="text-foreground">BtnA</code>. After bb0 returns to
            setup mode, reset this page and start from step 1.
          </p>
          <Button
            className="mt-3"
            variant="outline"
            onClick={() => {
              resetPage();
            }}
          >
            <IconRefresh size={16} />
            Reset page state
          </Button>
        </div>
      </div>
    </section>
  );
}

function deriveStatuses(state: {
  readonly connectionStatus: string;
  readonly wifiSent: boolean;
  readonly operationStatus: string;
}): {
  connect: StepStatus;
  wifi: StepStatus;
  code: StepStatus;
  headerLabel: string;
  headerTone: "neutral" | "success";
} {
  const connected = state.connectionStatus === "connected";
  const wifiSent = state.wifiSent;
  const confirmed = state.operationStatus === "confirmed";

  const connect: StepStatus = connected ? "complete" : "active";
  const wifi: StepStatus = wifiSent
    ? "complete"
    : connected
      ? "active"
      : "pending";
  const code: StepStatus = confirmed
    ? "complete"
    : wifiSent
      ? "active"
      : "pending";

  let headerLabel = "bb0 setup";
  let headerTone: "neutral" | "success" = "neutral";
  if (confirmed) {
    headerLabel = "bb0 ready";
    headerTone = "success";
  } else if (wifiSent) {
    headerLabel = "Waiting for device code";
  } else if (connected) {
    headerLabel = "bb0 connected";
    headerTone = "success";
  }

  return { connect, wifi, code, headerLabel, headerTone };
}

export function Bb0DevicePage() {
  const support = useGet(bb0BrowserSupport$);
  const state = useGet(bb0ProvisioningState$);

  if (!support.supported) {
    return <UnsupportedBrowser reason={support.reason} />;
  }

  const statuses = deriveStatuses(state);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">
      <PageHeader
        statusLabel={statuses.headerLabel}
        statusTone={statuses.headerTone}
      />
      <main className="px-4 pb-14 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          <BleConnectStep status={statuses.connect} />
          <WifiStep status={statuses.wifi} />
          <DeviceCodeStep status={statuses.code} />
          <ResetHelp />
        </div>
      </main>
    </div>
  );
}
