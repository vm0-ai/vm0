import { i18n } from "../../i18n/index.ts";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

interface AgentPhoneConnectParams {
  phoneHandle: string;
  agentphoneAgentId: string;
  timestamp: number;
  signature: string;
  channel?: string;
  publicBrand?: PublicBrand;
  publicBrandSignature?: string;
}

interface AgentPhoneConnectParamError {
  code: "incomplete" | "invalid_signature" | "invalid_timestamp";
  title: string;
  message: string;
}

type SearchParamValue = string | string[] | undefined;
type SearchParams = URLSearchParams | Record<string, SearchParamValue>;

type ParsedAgentPhoneConnectParams =
  | {
      ok: true;
      params: AgentPhoneConnectParams;
      channel: string | null;
      returnPath: string;
    }
  | { ok: false; error: AgentPhoneConnectParamError; returnPath: string };

function firstParam(
  searchParams: SearchParams,
  key: string,
): string | undefined {
  if (searchParams instanceof URLSearchParams) {
    return searchParams.get(key) ?? undefined;
  }
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

export function isUnreliableAgentPhoneConnectChannel(
  channel: string | null | undefined,
): boolean {
  const normalized = channel?.trim().toLowerCase();
  return normalized === "sms" || normalized === "mms";
}

function encodeReturnPath(
  params: AgentPhoneConnectParams,
  channel: string | null,
): string {
  const search = new URLSearchParams({
    handle: params.phoneHandle,
    agent: params.agentphoneAgentId,
    ts: String(params.timestamp),
    sig: params.signature,
  });
  const effectiveChannel = channel ?? params.channel ?? null;
  if (effectiveChannel) {
    search.set("channel", effectiveChannel);
  }
  if (params.publicBrand) {
    search.set("publicBrand", params.publicBrand);
  }
  if (params.publicBrandSignature) {
    search.set("brandSig", params.publicBrandSignature);
  }
  return `/agentphone/connect?${search.toString()}`;
}

function invalidParams(
  code: "invalid_signature" | "invalid_timestamp",
  message: string,
): ParsedAgentPhoneConnectParams {
  return {
    ok: false,
    returnPath: "/agentphone/connect",
    error: {
      code,
      title: i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.invalidTitle;
      }),
      message,
    },
  };
}

function isPublicBrand(value: string | undefined): value is PublicBrand {
  return value === "vm0" || value === "okou";
}

function isValidSignature(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function parseTimestamp(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0
    ? timestamp
    : undefined;
}

interface ParsedBrandState {
  publicBrand?: PublicBrand;
  publicBrandSignature?: string;
}

function parseBrandState(
  publicBrand: string | undefined,
  publicBrandSignature: string | undefined,
): ParsedBrandState | undefined {
  if (publicBrand === undefined && publicBrandSignature === undefined) {
    // Old Platform -> new API rollout compatibility: old web/app clients can
    // remain active for about two days. Remove with #27750 after the client
    // floor excludes this Platform version and the final cutoff-eligible
    // ten-minute link has expired.
    return {};
  }
  if (
    !isPublicBrand(publicBrand) ||
    publicBrandSignature === undefined ||
    !isValidSignature(publicBrandSignature)
  ) {
    return undefined;
  }
  return { publicBrand, publicBrandSignature };
}

export function parseAgentPhoneConnectParams(
  searchParams: SearchParams,
): ParsedAgentPhoneConnectParams {
  const phoneHandle = firstParam(searchParams, "handle")?.trim();
  const agentphoneAgentId = firstParam(searchParams, "agent")?.trim();
  const tsRaw = firstParam(searchParams, "ts")?.trim();
  const signature = firstParam(searchParams, "sig")?.trim();
  const channel = firstParam(searchParams, "channel")?.trim().toLowerCase();
  const publicBrandRaw = firstParam(searchParams, "publicBrand")?.trim();
  const publicBrandSignature = firstParam(searchParams, "brandSig")?.trim();

  if (!phoneHandle || !agentphoneAgentId || !tsRaw || !signature) {
    return {
      ok: false,
      returnPath: "/agentphone/connect",
      error: {
        code: "incomplete",
        title: i18n.t(($) => {
          return $.connectors.providerConnect.agentphone.incompleteTitle;
        }),
        message: i18n.t(($) => {
          return $.connectors.providerConnect.agentphone.incompleteDescription;
        }),
      },
    };
  }

  const timestamp = parseTimestamp(tsRaw);
  if (timestamp === undefined) {
    return invalidParams(
      "invalid_timestamp",
      i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.invalidTimestamp;
      }),
    );
  }

  if (!isValidSignature(signature)) {
    return invalidParams(
      "invalid_signature",
      i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.invalidSignature;
      }),
    );
  }

  const brandState = parseBrandState(publicBrandRaw, publicBrandSignature);
  if (brandState === undefined) {
    return invalidParams(
      "invalid_signature",
      i18n.t(($) => {
        return $.connectors.providerConnect.agentphone.invalidSignature;
      }),
    );
  }

  const params: AgentPhoneConnectParams = {
    phoneHandle,
    agentphoneAgentId,
    timestamp,
    signature,
    ...(channel ? { channel } : {}),
    ...(brandState.publicBrand ? { publicBrand: brandState.publicBrand } : {}),
    ...(brandState.publicBrandSignature
      ? { publicBrandSignature: brandState.publicBrandSignature }
      : {}),
  };

  return {
    ok: true,
    params,
    channel: channel || null,
    returnPath: encodeReturnPath(params, channel || null),
  };
}
