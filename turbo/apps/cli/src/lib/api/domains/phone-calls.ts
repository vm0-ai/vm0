import { getClientConfig, ApiRequestError } from "../core/client-factory";

interface PhoneCallResponse {
  callId: string;
  status: string;
}

interface PhoneCallListResponse {
  data: Array<Record<string, unknown>>;
  total: number;
  hasMore: boolean;
}

interface PhoneCallDetailResponse {
  call: Record<string, unknown>;
  transcript: unknown;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const config = await getClientConfig();
  const url = `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...config.baseHeaders,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers as Record<string, string>),
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => {
      return {};
    })) as {
      error?: string;
    };
    throw new ApiRequestError(
      body.error ?? `Request failed with status ${res.status}`,
      "API_ERROR",
      res.status,
    );
  }

  return (await res.json()) as T;
}

export async function createPhoneCall(body: {
  toNumber: string;
  greeting?: string;
  systemPrompt?: string;
}): Promise<PhoneCallResponse> {
  return fetchJson<PhoneCallResponse>("/api/zero/phone-calls", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listPhoneCalls(query?: {
  limit?: number;
  offset?: number;
}): Promise<PhoneCallListResponse> {
  const params = new URLSearchParams();
  if (query?.limit) params.set("limit", String(query.limit));
  if (query?.offset) params.set("offset", String(query.offset));
  const qs = params.toString();
  return fetchJson<PhoneCallListResponse>(
    `/api/zero/phone-calls${qs ? `?${qs}` : ""}`,
  );
}

export async function getPhoneCallDetail(
  callId: string,
): Promise<PhoneCallDetailResponse> {
  return fetchJson<PhoneCallDetailResponse>(
    `/api/zero/phone-calls/${encodeURIComponent(callId)}`,
  );
}
