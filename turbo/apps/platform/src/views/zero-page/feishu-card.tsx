import type { FormEvent } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconCircleCheck,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconLoader2,
  IconSettings,
} from "@tabler/icons-react";
import type { FeishuConnectStatus } from "@vm0/api-contracts/contracts/zero-feishu-connect";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { Button } from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { toast } from "@vm0/ui/components/ui/sonner";

import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { writeToClipboard } from "../../signals/zero-page/clipboard.ts";
import {
  closeFeishuDialog$,
  disconnectFeishuOrg$,
  feishuDialogOpen$,
  feishuEditing$,
  feishuOrgData$,
  feishuSetupForm$,
  openFeishuDialog$,
  pollFeishuSetupStatus$,
  removeFeishuOrg$,
  setFeishuEditing$,
  setupFeishuOrg$,
  updateFeishuSetupForm$,
  type FeishuSetupInput,
} from "../../signals/zero-page/zero-feishu.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const feishuIconImg = settingsIconAssetUrl("lark");
const FEISHU_DEVELOPER_CONSOLE_URL = "https://open.feishu.cn/app";
const FEISHU_PERMISSION_CONFIG = JSON.stringify(
  {
    scopes: {
      tenant: ["im:message.p2p_msg:readonly", "im:message:send_as_bot"],
      user: [],
    },
  },
  null,
  2,
);

function agentLabel(
  agent: TeamComposeItem,
  defaultAgentId: string | null,
  defaultAgentName: string | null,
): string {
  if (agent.id === defaultAgentId && defaultAgentName) {
    return defaultAgentName;
  }
  return agent.displayName ?? agent.id;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const copy = () => {
    detach(
      (async () => {
        const copied = await writeToClipboard(value);
        if (copied) {
          toast.success(`${label} copied`);
        }
      })(),
      Reason.DomCallback,
    );
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      <IconCopy size={14} />
      Copy
    </Button>
  );
}

function SetupStatus({
  complete,
  children,
}: {
  complete: boolean;
  children: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-secondary-foreground">
      {complete ? (
        <IconCircleCheck className="h-4 w-4 text-green-600" />
      ) : (
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
      )}
      {children}
    </span>
  );
}

type FeishuCredentialField = Exclude<keyof FeishuSetupInput, "defaultAgentId">;

function FeishuCredentialInput({
  field,
  label,
  form,
  saving,
  placeholder,
}: {
  field: FeishuCredentialField;
  label: string;
  form: FeishuSetupInput;
  saving: boolean;
  placeholder?: string;
}) {
  const updateForm = useSet(updateFeishuSetupForm$);
  const id = `feishu-${field}`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type={field === "appId" ? "text" : "password"}
        value={form[field]}
        disabled={saving}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(event) => {
          updateForm({ [field]: event.target.value });
        }}
      />
    </div>
  );
}

function FeishuCredentialFields({
  form,
  saving,
}: {
  form: FeishuSetupInput;
  saving: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FeishuCredentialInput
        field="appId"
        label="App ID"
        form={form}
        saving={saving}
        placeholder="cli_..."
      />
      <FeishuCredentialInput
        field="appSecret"
        label="App Secret"
        form={form}
        saving={saving}
      />
      <FeishuCredentialInput
        field="verificationToken"
        label="Verification Token"
        form={form}
        saving={saving}
      />
      <FeishuCredentialInput
        field="encryptKey"
        label="Encrypt Key"
        form={form}
        saving={saving}
      />
    </div>
  );
}

function FeishuAgentSelect({
  form,
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
  saving,
}: {
  form: FeishuSetupInput;
  agents: TeamComposeItem[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
  saving: boolean;
}) {
  const updateForm = useSet(updateFeishuSetupForm$);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="feishu-default-agent" className="text-sm font-medium">
        Default agent
      </label>
      <Select
        value={form.defaultAgentId}
        disabled={saving}
        onValueChange={(defaultAgentId) => {
          updateForm({ defaultAgentId });
        }}
      >
        <SelectTrigger id="feishu-default-agent">
          <SelectValue placeholder="Select an agent" />
        </SelectTrigger>
        <SelectContent>
          {agents.map((agent) => {
            return (
              <SelectItem key={agent.id} value={agent.id}>
                {agentLabel(agent, orgDefaultAgentId, orgDefaultAgentName)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function canSubmitFeishuSetup(
  form: FeishuSetupInput,
  saving: boolean,
): boolean {
  return (
    !saving &&
    form.appId.trim().length > 0 &&
    form.appSecret.trim().length > 0 &&
    form.verificationToken.trim().length > 0 &&
    form.encryptKey.trim().length > 0 &&
    form.defaultAgentId.length > 0
  );
}

function FeishuSetupForm({
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
  onSaved,
}: {
  agents: TeamComposeItem[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
  onSaved: () => void;
}) {
  const form = useGet(feishuSetupForm$);
  const updateForm = useSet(updateFeishuSetupForm$);
  const [setupLoadable, setup] = useLoadableSet(setupFeishuOrg$);
  const signal = useGet(pageSignal$);
  const saving = setupLoadable.state === "loading";
  const canSave = canSubmitFeishuSetup(form, saving);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) {
      return;
    }
    detach(
      (async () => {
        await setup(
          {
            appId: form.appId.trim(),
            appSecret: form.appSecret.trim(),
            verificationToken: form.verificationToken.trim(),
            encryptKey: form.encryptKey.trim(),
            defaultAgentId: form.defaultAgentId,
          },
          signal,
        );
        updateForm({ appSecret: "", verificationToken: "", encryptKey: "" });
        onSaved();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <FeishuCredentialFields form={form} saving={saving} />
      <FeishuAgentSelect
        form={form}
        agents={agents}
        orgDefaultAgentId={orgDefaultAgentId}
        orgDefaultAgentName={orgDefaultAgentName}
        saving={saving}
      />
      <DialogFooter>
        <Button type="submit" disabled={!canSave}>
          {saving ? <IconLoader2 size={16} className="animate-spin" /> : null}
          {saving ? "Verifying…" : "Verify and continue"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function FeishuSetupSteps({ data }: { data: FeishuConnectStatus }) {
  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">1. Import permissions</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              In Permission Management, choose batch import and paste this JSON.
            </p>
          </div>
          <CopyButton
            value={FEISHU_PERMISSION_CONFIG}
            label="Permission JSON"
          />
        </div>
        <pre className="max-h-36 overflow-auto rounded-md bg-muted p-3 text-xs">
          {FEISHU_PERMISSION_CONFIG}
        </pre>
      </section>

      <section className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">2. Configure events</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose “Send events to developer server”, paste this URL, then add
              <code className="ml-1">im.message.receive_v1</code>.
            </p>
          </div>
          <SetupStatus complete={data.callbackVerified}>
            {data.callbackVerified
              ? "Callback verified"
              : "Waiting for callback"}
          </SetupStatus>
        </div>
        <div className="flex gap-2">
          <Input value={data.callbackUrl ?? ""} readOnly />
          {data.callbackUrl ? (
            <CopyButton value={data.callbackUrl} label="Callback URL" />
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">3. Publish and test</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Create and publish an app version, then send the bot a direct
              message. Click the returned link once to connect your VM0 account.
            </p>
          </div>
          <SetupStatus complete={data.messageReceived}>
            {data.messageReceived
              ? "Test message received"
              : "Waiting for message"}
          </SetupStatus>
        </div>
      </section>
    </div>
  );
}

function cardDescription(data: FeishuConnectStatus | null): string {
  if (data?.isConnected) {
    return `Direct messages run ${data.defaultAgentName ?? "the configured agent"}`;
  }
  if (data?.isInstalled) {
    return data.messageReceived
      ? "Send the bot a message and use its link to connect your account"
      : "Finish the callback setup and send the bot a test message";
  }
  return data?.isAdmin
    ? "Connect a Feishu custom app to an agent"
    : "Ask an organization admin to configure Feishu";
}

function FeishuCardSummary({
  data,
  onOpen,
}: {
  data: FeishuConnectStatus | null;
  onOpen: () => void;
}) {
  const isConnected = data?.isConnected ?? false;
  const isInstalled = data?.isInstalled ?? false;
  const showSetup = (data?.isAdmin ?? false) || isInstalled;
  return (
    <div className="zero-card flex items-center gap-4 p-4">
      <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden">
        <img src={feishuIconImg} alt="" className="h-7 w-7" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-sm font-medium text-foreground">Feishu</div>
        <div className="text-sm text-muted-foreground">
          {cardDescription(data)}
        </div>
      </div>
      {isConnected ? (
        <span
          data-testid="feishu-connected-indicator"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
        >
          <IconCircleCheck className="h-3 w-3 text-green-600" />
          Connected
        </span>
      ) : null}
      {showSetup ? (
        <Button
          data-testid="feishu-setup-button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={onOpen}
        >
          <IconSettings size={14} stroke={1.5} />
          {isInstalled ? "Manage" : "Set up"}
        </Button>
      ) : null}
    </div>
  );
}

function FeishuDialogActions({
  data,
  editing,
  onEdit,
}: {
  data: FeishuConnectStatus | null;
  editing: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" asChild>
        <a href="/icons/icon-512.png" download="vm0-feishu-app-icon.png">
          <IconDownload size={14} />
          Download VM0 app icon
        </a>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          window.open(
            FEISHU_DEVELOPER_CONSOLE_URL,
            "_blank",
            "noopener,noreferrer",
          );
        }}
      >
        <IconExternalLink size={14} />
        Open Feishu developer console
      </Button>
      {data?.isInstalled && data.isAdmin && !editing ? (
        <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
          Replace credentials or agent
        </Button>
      ) : null}
    </div>
  );
}

function FeishuDialogBody({
  data,
  editing,
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
  onSaved,
}: {
  data: FeishuConnectStatus | null;
  editing: boolean;
  agents: TeamComposeItem[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
  onSaved: () => void;
}) {
  if (!data?.isAdmin) {
    return (
      <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        An organization admin must configure or replace the app credentials. You
        can connect your own account after the bot sends you a VM0 link.
      </p>
    );
  }
  if (!data.isInstalled || editing) {
    return (
      <FeishuSetupForm
        agents={agents}
        orgDefaultAgentId={orgDefaultAgentId}
        orgDefaultAgentName={orgDefaultAgentName}
        onSaved={onSaved}
      />
    );
  }
  return <FeishuSetupSteps data={data} />;
}

function FeishuDialogFooter({
  data,
  onRemoved,
}: {
  data: FeishuConnectStatus | null;
  onRemoved: () => void;
}) {
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectFeishuOrg$);
  const [removeLoadable, remove] = useLoadableSet(removeFeishuOrg$);
  const signal = useGet(pageSignal$);
  if (!data?.isInstalled) {
    return null;
  }
  return (
    <DialogFooter className="border-t border-border pt-4 sm:justify-between">
      <div>
        {data.isAdmin ? (
          <Button
            type="button"
            variant="ghost"
            disabled={removeLoadable.state === "loading"}
            onClick={() => {
              detach(
                (async () => {
                  await remove(signal);
                  onRemoved();
                })(),
                Reason.DomCallback,
              );
            }}
          >
            {removeLoadable.state === "loading"
              ? "Removing…"
              : "Remove integration"}
          </Button>
        ) : null}
      </div>
      {data.isConnected ? (
        <Button
          type="button"
          variant="outline"
          disabled={disconnectLoadable.state === "loading"}
          onClick={() => {
            detach(disconnect(signal), Reason.DomCallback);
          }}
        >
          {disconnectLoadable.state === "loading"
            ? "Disconnecting…"
            : "Disconnect my account"}
        </Button>
      ) : null}
    </DialogFooter>
  );
}

function FeishuSetupDialog({
  data,
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
}: {
  data: FeishuConnectStatus | null;
  agents: TeamComposeItem[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
}) {
  const open = useGet(feishuDialogOpen$);
  const editing = useGet(feishuEditing$);
  const close = useSet(closeFeishuDialog$);
  const setEditing = useSet(setFeishuEditing$);
  const pollStatus = useSet(pollFeishuSetupStatus$);
  const signal = useGet(pageSignal$);
  const editDefaults = {
    appId: data?.appId ?? "",
    defaultAgentId:
      data?.defaultAgentId ?? orgDefaultAgentId ?? agents[0]?.id ?? "",
  };
  const startPolling = () => {
    detach(pollStatus(signal), Reason.DomCallback);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          close();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect a Feishu custom app</DialogTitle>
          <DialogDescription>
            Create an enterprise custom app named VM0, enable its bot, and
            complete these steps in the Feishu developer console.
          </DialogDescription>
        </DialogHeader>
        <FeishuDialogActions
          data={data}
          editing={editing}
          onEdit={() => {
            setEditing(editDefaults);
          }}
        />
        <FeishuDialogBody
          data={data}
          editing={editing}
          agents={agents}
          orgDefaultAgentId={orgDefaultAgentId}
          orgDefaultAgentName={orgDefaultAgentName}
          onSaved={() => {
            setEditing(null);
            startPolling();
          }}
        />
        <FeishuDialogFooter data={data} onRemoved={close} />
      </DialogContent>
    </Dialog>
  );
}

export function FeishuCard() {
  const dataLoadable = useLastLoadable(feishuOrgData$);
  const agentsLoadable = useLastLoadable(sortedAgents$);
  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultAgentNameLoadable = useLastLoadable(defaultAgentName$);
  const open = useSet(openFeishuDialog$);
  const pollStatus = useSet(pollFeishuSetupStatus$);
  const signal = useGet(pageSignal$);
  const data = dataLoadable.state === "hasData" ? dataLoadable.data : null;
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const orgDefaultAgentId =
    defaultAgentIdLoadable.state === "hasData"
      ? defaultAgentIdLoadable.data
      : null;
  const orgDefaultAgentName =
    defaultAgentNameLoadable.state === "hasData"
      ? defaultAgentNameLoadable.data
      : null;
  const defaults = {
    appId: data?.appId ?? "",
    defaultAgentId:
      data?.defaultAgentId ?? orgDefaultAgentId ?? agents[0]?.id ?? "",
  };

  return (
    <>
      <FeishuCardSummary
        data={data}
        onOpen={() => {
          open(defaults);
          if (data?.isInstalled && !data.messageReceived) {
            detach(pollStatus(signal), Reason.DomCallback);
          }
        }}
      />
      <FeishuSetupDialog
        data={data}
        agents={agents}
        orgDefaultAgentId={orgDefaultAgentId}
        orgDefaultAgentName={orgDefaultAgentName}
      />
    </>
  );
}
