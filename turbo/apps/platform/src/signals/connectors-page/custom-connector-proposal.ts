import { command, computed, state } from "ccstate";
import {
  type CustomConnectorField,
  customConnectorProposalSchema,
  type CustomConnectorProposal,
  type CustomConnectorValueInput,
  zeroCustomConnectorProposalContract,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { agents$ } from "../agent.ts";
import { searchParams$ } from "../route.ts";
import { jsonParseBase64UrlOr } from "../utils.ts";

interface CustomConnectorProposalParams {
  readonly proposal: CustomConnectorProposal;
  readonly agentId: string | null;
}

type FieldValueMap = Readonly<Record<string, string>>;

function fieldValueId(field: CustomConnectorField): string {
  return `${field.kind}:${field.key}`;
}

function buildValues(
  fields: readonly CustomConnectorField[],
  valueMap: FieldValueMap,
): CustomConnectorValueInput[] {
  return fields.flatMap((field) => {
    const value = valueMap[fieldValueId(field)]?.trim() ?? "";
    if (!value) {
      return [];
    }
    return [{ key: field.key, kind: field.kind, value }];
  });
}

function hasRequiredValues(
  fields: readonly CustomConnectorField[],
  valueMap: FieldValueMap,
): boolean {
  return fields.every((field) => {
    if (!field.required) {
      return true;
    }
    return (valueMap[fieldValueId(field)] ?? "").trim().length > 0;
  });
}

const internalValueMap$ = state<FieldValueMap>({});
const internalSaved$ = state(false);

export const customConnectorProposalParams$ = computed(
  (get): CustomConnectorProposalParams | null => {
    const params = get(searchParams$);
    const encoded = params.get("p");
    if (!encoded) {
      return null;
    }
    const decoded = jsonParseBase64UrlOr<unknown | null>(encoded, null);
    if (decoded === null) {
      return null;
    }
    const parsed = customConnectorProposalSchema.safeParse(decoded);
    if (!parsed.success) {
      return null;
    }
    return {
      proposal: parsed.data,
      agentId: params.get("agentId"),
    };
  },
);

export const customConnectorProposalAgentName$ = computed(async (get) => {
  const params = get(customConnectorProposalParams$);
  if (!params?.agentId) {
    return null;
  }
  const agents = await get(agents$);
  const agent = agents.find((item) => {
    return item.id === params.agentId;
  });
  return agent?.displayName ?? null;
});

export const customConnectorProposalValueMap$ = computed((get) => {
  return get(internalValueMap$);
});

const customConnectorProposalValues$ = computed((get) => {
  const params = get(customConnectorProposalParams$);
  if (!params) {
    return [];
  }
  return buildValues(params.proposal.fields, get(internalValueMap$));
});

export const customConnectorProposalSaved$ = computed((get) => {
  return get(internalSaved$);
});

export const customConnectorProposalCanSave$ = computed((get) => {
  const params = get(customConnectorProposalParams$);
  if (!params || get(internalSaved$)) {
    return false;
  }
  return hasRequiredValues(params.proposal.fields, get(internalValueMap$));
});

export const resetCustomConnectorProposalForm$ = command(({ set }) => {
  set(internalValueMap$, {});
  set(internalSaved$, false);
});

export const setCustomConnectorProposalFieldValue$ = command(
  ({ set }, field: CustomConnectorField, value: string) => {
    const id = fieldValueId(field);
    set(internalValueMap$, (current) => {
      return { ...current, [id]: value };
    });
  },
);

export const saveCustomConnectorProposal$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(customConnectorProposalParams$);
    if (!params) {
      throw new Error("Invalid custom connector proposal");
    }

    const client = get(zeroClient$)(zeroCustomConnectorProposalContract);
    const result = await accept(
      client.save({
        body: {
          proposal: params.proposal,
          values: get(customConnectorProposalValues$),
          ...(params.agentId ? { agentId: params.agentId } : {}),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalSaved$, true);
    return result.body;
  },
);
