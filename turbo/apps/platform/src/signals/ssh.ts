import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  agentSshAccessContract,
  sshChangedPayloadSchema,
} from "@okouai/api-contracts/contracts/ssh-access";
import { setAblyPayloadLoop$ } from "./realtime.ts";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
  createSshConnectionRequestSchema,
  updateSshConnectionRequestSchema,
  SSH_PRIVATE_KEY_MAX_LENGTH,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { clerk$, currentOrgInfo$, currentUserInfo$ } from "./auth.ts";
import { readClerkToken } from "./clerk-token.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { apiClient$ } from "./api-client.ts";
import { currentAgent$, agents$ } from "./agent.ts";
import { accept } from "../lib/accept.ts";
import {
  createDeferredPromise,
  onRef,
  resetSignal,
  settle,
  withCleanup,
} from "./utils.ts";

type PrivateKeyFileError = "size" | "read";
const privateKeyFileRead$ = state<Promise<PrivateKeyFileError | null> | null>(
  null,
);
const resetPrivateKeyRead$ = resetSignal();
export const sshPrivateKeyFileResult$ = computed(async (get) => {
  return await get(privateKeyFileRead$);
});
export const cancelSshPrivateKeyFile$ = command(({ set }) => {
  set(resetPrivateKeyRead$);
  set(privateKeyFileRead$, null);
});
export const mountSshPrivateKey$ = onRef(
  command(({ set }, input: HTMLTextAreaElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      input.value = "";
      set(cancelSshPrivateKeyFile$);
    });
  }),
);

const readPrivateKeyFile$ = command(
  async (
    { set },
    input: HTMLInputElement,
    parentSignal: AbortSignal,
  ): Promise<PrivateKeyFileError | null> => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) {
      return null;
    }
    set(cancelSshPrivateKeyFile$);
    const signal = set(resetPrivateKeyRead$, parentSignal);
    signal.throwIfAborted();
    const privateKey = input.form?.elements.namedItem("privateKey");
    if (!(privateKey instanceof HTMLTextAreaElement)) {
      throw new Error("SSH credential form is missing its private key field");
    }
    privateKey.value = "";
    if (file.size === 0 || file.size > SSH_PRIVATE_KEY_MAX_LENGTH) {
      return "size";
    }
    const aborted = createDeferredPromise<never>(signal);
    const result = await withCleanup(
      settle(Promise.race([file.text(), aborted.promise]), signal),
      () => {
        if (!aborted.settled()) {
          aborted.reject(new DOMException("File read finished", "AbortError"));
        }
      },
    );
    signal.throwIfAborted();
    if (!result.ok) {
      return "read";
    }
    if (result.value.length === 0) {
      return "size";
    }
    privateKey.value = result.value;
    return null;
  },
);
export const importSshPrivateKeyFile$ = command(
  ({ set }, input: HTMLInputElement, signal: AbortSignal) => {
    // Persist only the non-secret outcome, never the File or decoded key.
    const result = set(readPrivateKeyFile$, input, signal);
    set(privateKeyFileRead$, result);
    return result;
  },
);

export const sshIdentity$ = computed(async (get) => {
  const enabled = get(featureSwitch$)[FeatureSwitchKey.SshAccess];
  if (!enabled) {
    return null;
  }
  const [org, user] = await Promise.all([
    get(currentOrgInfo$),
    get(currentUserInfo$),
  ]);
  return org && user ? `${org.id}:${user.id}` : null;
});
const reload$ = state(0);
const sshClients$ = computed(async (get) => {
  const identity = await get(sshIdentity$);
  const clerk = await get(clerk$);
  const sessionId = clerk.session?.id;
  const createClient = get(apiClient$);
  const assertIdentity = () => {
    if (
      !identity ||
      !sessionId ||
      sessionId !== clerk.session?.id ||
      identity !== `${clerk.organization?.id}:${clerk.user?.id}`
    ) {
      throw new DOMException("SSH owner changed", "AbortError");
    }
  };
  const options = {
    getToken: async (signal: AbortSignal) => {
      assertIdentity();
      const token = await readClerkToken(clerk, signal);
      signal.throwIfAborted();
      assertIdentity();
      return token;
    },
  };
  return {
    identity,
    connections: createClient(sshConnectionsContract, options),
    access: createClient(agentSshAccessContract, options),
  };
});
const dialog$ = state<{
  readonly identity: string;
  readonly kind: "create" | "edit" | "rotate" | "delete" | "reset";
  readonly connection: SshConnectionResponse | null;
} | null>(null);
const conflict$ = state<string | null>(null);
export const sshConflict$ = computed((get) => {
  return get(conflict$);
});
export const sshDialog$ = computed(async (get) => {
  const dialog = get(dialog$);
  return dialog?.identity === (await get(sshIdentity$)) ? dialog : null;
});
export const sshConnections$ = computed(async (get) => {
  get(reload$);
  if (!(await get(sshIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(sshClients$)).connections.list(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.connections : null;
});
export const sshSummary$ = computed(async (get) => {
  get(reload$);
  if (!(await get(sshIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(sshClients$)).connections.summary(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body : null;
});
export const closeSshDialog$ = command(({ set }) => {
  set(cancelSshPrivateKeyFile$);
  return set(dialog$, null);
});
export const refreshSsh$ = command(({ set }) => {
  set(cancelSshPrivateKeyFile$);
  set(dialog$, null);
  set(conflict$, null);
  set(closeSshAccessManagement$);
  set(invalidateSsh$);
});

// Background changes must not discard an open credential form or dialog.
export const invalidateSsh$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

const catchUpSsh$ = command(({ set }) => {
  set(invalidateSsh$);
  return false;
});
const onSshChanged$ = command(
  async ({ get, set }, payload: unknown, signal: AbortSignal) => {
    const parsed = sshChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    const org = await get(currentOrgInfo$);
    signal.throwIfAborted();
    if (org?.id === parsed.data.orgId) {
      set(invalidateSsh$);
    }
    return false;
  },
);
export const subscribeSshChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(
      setAblyPayloadLoop$,
      {
        topic: "ssh:changed",
        loopCommand$: onSshChanged$,
        catchUpCommand$: catchUpSsh$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);
export const openSshDialog$ = command(
  async (
    { get, set },
    kind: "create" | "edit" | "rotate" | "delete" | "reset",
    connection: SshConnectionResponse | null,
    signal: AbortSignal,
  ) => {
    const identity = await get(sshIdentity$);
    signal.throwIfAborted();
    if (!identity) {
      return;
    }
    set(conflict$, null);
    set(cancelSshPrivateKeyFile$);
    set(dialog$, { identity, kind, connection });
  },
);

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string") {
    throw new Error(`Missing SSH form field: ${name}`);
  }
  return value;
}

export const saveSsh$ = command(
  async ({ get, set }, form: FormData, signal: AbortSignal) => {
    const dialog = await get(sshDialog$);
    signal.throwIfAborted();
    if (!dialog) {
      return;
    }
    const clients = await get(sshClients$);
    signal.throwIfAborted();
    if (clients.identity !== dialog.identity) {
      return;
    }
    const client = clients.connections;
    const credentials =
      dialog.kind === "create" || dialog.kind === "rotate"
        ? {
            privateKey: textField(form, "privateKey"),
            passphrase: textField(form, "passphrase") || null,
          }
        : undefined;
    const fields =
      dialog.kind === "create" || dialog.kind === "edit"
        ? {
            displayName: textField(form, "displayName"),
            host: textField(form, "host"),
            port: Number(textField(form, "port")),
            username: textField(form, "username"),
          }
        : undefined;
    let conflicted: string | null = null;
    if (dialog.kind === "create") {
      const body = createSshConnectionRequestSchema.parse({
        ...fields,
        ...credentials,
      });
      await accept(
        client.create({ body, fetchOptions: { signal } }),
        [201],
        signal,
      );
    } else {
      const connection = dialog.connection;
      if (!connection) {
        throw new Error("SSH edit requires a connection");
      }
      const params = { connectionId: connection.id };
      if (dialog.kind === "delete") {
        await accept(
          client.delete({ params, fetchOptions: { signal } }),
          [204],
          signal,
        );
      } else if (dialog.kind === "reset") {
        const result = await accept(
          client.resetHostKey({
            params,
            body: { expectedGeneration: connection.generation },
            fetchOptions: { signal },
          }),
          [200, 409],
          signal,
        );
        conflicted = result.status === 409 ? result.body.error.code : null;
      } else {
        const body = updateSshConnectionRequestSchema.parse({
          expectedGeneration: connection.generation,
          ...fields,
          ...(credentials ? { credentials } : {}),
        });
        const result = await accept(
          client.update({ params, body, fetchOptions: { signal } }),
          [200, 409],
          signal,
        );
        conflicted = result.status === 409 ? result.body.error.code : null;
      }
    }
    signal.throwIfAborted();
    if (dialog.identity !== (await get(sshIdentity$))) {
      return;
    }
    signal.throwIfAborted();
    set(dialog$, null);
    set(conflict$, conflicted);
    set(reload$, (value) => {
      return value + 1;
    });
  },
);

export const currentAgentSshAccess$ = computed(async (get) => {
  get(reload$);
  const identity = await get(sshIdentity$);
  if (!identity) {
    return null;
  }
  const [agent, summary] = await Promise.all([
    get(currentAgent$),
    get(sshSummary$),
  ]);
  if (!agent || !summary || summary.configuredCount === 0) {
    return null;
  }
  const result = await accept(
    (await get(sshClients$)).access.get({
      params: { agentId: agent.agentId },
    }),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200
    ? { identity, agentId: agent.agentId, ...result.body }
    : null;
});
export const updateAgentSshAccess$ = command(
  async (
    { get, set },
    agentId: string,
    enabled: boolean,
    signal: AbortSignal,
  ) => {
    const clients = await get(sshClients$);
    signal.throwIfAborted();
    const [summary, visibleAgents] = await Promise.all([
      get(sshSummary$),
      get(agents$),
    ]);
    signal.throwIfAborted();
    if (
      !summary ||
      summary.configuredCount === 0 ||
      !visibleAgents.some((agent) => {
        return agent.agentId === agentId;
      })
    ) {
      return;
    }
    await accept(
      clients.access.update({
        params: { agentId },
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (clients.identity !== (await get(sshIdentity$))) {
      return;
    }
    signal.throwIfAborted();
    set(invalidateSsh$);
  },
);

export const sshAgentAccessRows$ = computed(async (get) => {
  const summary = await get(sshSummary$);
  if (!summary) {
    return null;
  }
  if (summary.configuredCount === 0) {
    return [];
  }
  const [visibleAgents, clients] = await Promise.all([
    get(agents$),
    get(sshClients$),
  ]);
  const rows = await Promise.all(
    visibleAgents.map(async (agent) => {
      const result = await accept(
        clients.access.get({ params: { agentId: agent.agentId } }),
        [200, 404],
        undefined,
        { showErrorToast: false },
      );
      return result.status === 200
        ? { agent, enabled: result.body.enabled }
        : null;
    }),
  );
  return rows.filter((row) => {
    return row !== null;
  });
});

// Keep the owner attached when views retain this read during a background refresh.
export const sshAgentAccessSnapshot$ = computed(async (get) => {
  const [identity, rows] = await Promise.all([
    get(sshIdentity$),
    get(sshAgentAccessRows$),
  ]);
  return { identity, rows };
});

const accessManagementIdentity$ = state<string | null>(null);
const accessSearch$ = state("");
export const sshAccessSearch$ = computed((get) => {
  return get(accessSearch$);
});
export const searchSshAccess$ = command(({ set }, value: string) => {
  return set(accessSearch$, value);
});
export const sshAccessManagementOpen$ = computed(async (get) => {
  const identity = get(accessManagementIdentity$);
  return identity !== null && identity === (await get(sshIdentity$));
});
export const closeSshAccessManagement$ = command(({ set }) => {
  set(accessManagementIdentity$, null);
  set(accessSearch$, "");
});
export const openSshAccessManagement$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const identity = await get(sshIdentity$);
    signal.throwIfAborted();
    set(accessManagementIdentity$, identity);
    set(accessSearch$, "");
    set(invalidateSsh$);
  },
);
