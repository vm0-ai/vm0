interface WhatsAppConnectParams {
  phoneHandle: string;
  timestamp: number;
  signature: string;
}

interface WhatsAppConnectParamError {
  title: string;
  message: string;
}

type SearchParamValue = string | string[] | undefined;
type SearchParams = URLSearchParams | Record<string, SearchParamValue>;

type ParsedWhatsAppConnectParams =
  | {
      ok: true;
      params: WhatsAppConnectParams;
      returnPath: string;
    }
  | { ok: false; error: WhatsAppConnectParamError; returnPath: string };

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

function encodeReturnPath(params: WhatsAppConnectParams): string {
  const search = new URLSearchParams({
    handle: params.phoneHandle,
    ts: String(params.timestamp),
    sig: params.signature,
  });
  return `/whatsapp/connect?${search.toString()}`;
}

function invalidParams(message: string): ParsedWhatsAppConnectParams {
  return {
    ok: false,
    returnPath: "/whatsapp/connect",
    error: {
      title: "Connect link is invalid",
      message,
    },
  };
}

export function parseWhatsAppConnectParams(
  searchParams: SearchParams,
): ParsedWhatsAppConnectParams {
  const phoneHandle = firstParam(searchParams, "handle")?.trim();
  const tsRaw = firstParam(searchParams, "ts")?.trim();
  const signature = firstParam(searchParams, "sig")?.trim();

  if (!phoneHandle || !tsRaw || !signature) {
    return {
      ok: false,
      returnPath: "/whatsapp/connect",
      error: {
        title: "Connect link is incomplete",
        message: "Open a fresh /connect link from your WhatsApp messages.",
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

  const params: WhatsAppConnectParams = {
    phoneHandle,
    timestamp,
    signature,
  };

  return {
    ok: true,
    params,
    returnPath: encodeReturnPath(params),
  };
}
