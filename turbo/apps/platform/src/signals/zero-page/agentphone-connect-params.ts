interface AgentPhoneConnectParams {
  phoneHandle: string;
  agentphoneAgentId: string;
  timestamp: number;
  signature: string;
}

export const AGENTPHONE_SMS_MMS_CONNECT_RISK_MESSAGE =
  "SMS and MMS replies may not be delivered reliably. For the most reliable experience, use iMessage with this AgentPhone number.";

interface AgentPhoneConnectParamError {
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
  if (channel) {
    search.set("channel", channel);
  }
  return `/agentphone/connect?${search.toString()}`;
}

function invalidParams(message: string): ParsedAgentPhoneConnectParams {
  return {
    ok: false,
    returnPath: "/agentphone/connect",
    error: {
      title: "Connect link is invalid",
      message,
    },
  };
}

export function parseAgentPhoneConnectParams(
  searchParams: SearchParams,
): ParsedAgentPhoneConnectParams {
  const phoneHandle = firstParam(searchParams, "handle")?.trim();
  const agentphoneAgentId = firstParam(searchParams, "agent")?.trim();
  const tsRaw = firstParam(searchParams, "ts")?.trim();
  const signature = firstParam(searchParams, "sig")?.trim();
  const channel = firstParam(searchParams, "channel")?.trim().toLowerCase();

  if (!phoneHandle || !agentphoneAgentId || !tsRaw || !signature) {
    return {
      ok: false,
      returnPath: "/agentphone/connect",
      error: {
        title: "Connect link is incomplete",
        message: "Open a fresh /connect link from your text messages.",
      },
    };
  }

  if (!/^\d+$/.test(tsRaw)) {
    return invalidParams("The timestamp on this link is not valid.");
  }

  const timestamp = Number(tsRaw);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return invalidParams("The timestamp on this link is not valid.");
  }

  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return invalidParams("The signature on this link is not valid.");
  }

  const params = {
    phoneHandle,
    agentphoneAgentId,
    timestamp,
    signature,
  };

  return {
    ok: true,
    params,
    channel: channel || null,
    returnPath: encodeReturnPath(params, channel || null),
  };
}
