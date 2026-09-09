import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
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
import { currentAgent$ } from "./agent.ts";
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

const sshIdentity$ = computed(async (get) => {
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
const conflict$ = state(false);
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
  set(conflict$, false);
  set(reload$, (value) => {
    return value + 1;
  });
});
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
    set(conflict$, false);
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
    let conflicted = false;
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
        conflicted = result.status === 409;
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
        conflicted = result.status === 409;
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

const accessReload$ = state(0);
export const currentAgentSshAccess$ = computed(async (get) => {
  get(accessReload$);
  if (!(await get(sshIdentity$))) {
    return null;
  }
  const [agent, user] = await Promise.all([
    get(currentAgent$),
    get(currentUserInfo$),
  ]);
  if (!agent || agent.ownerId !== user?.id) {
    return null;
  }
  const result = await accept(
    (await get(sshClients$)).access.get({
      params: { agentId: agent.agentId },
    }),
    [200, 404],
  );
  return result.status === 200
    ? { agentId: agent.agentId, ...result.body }
    : null;
});
export const updateCurrentAgentSshAccess$ = command(
  async (
    { get, set },
    agentId: string,
    enabled: boolean,
    signal: AbortSignal,
  ) => {
    const access = await get(currentAgentSshAccess$);
    signal.throwIfAborted();
    if (access?.agentId !== agentId) {
      return;
    }
    await accept(
      (await get(sshClients$)).access.update({
        params: { agentId },
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(accessReload$, (value) => {
      return value + 1;
    });
  },
);
