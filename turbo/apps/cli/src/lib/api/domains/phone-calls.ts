import { getClientConfig, ApiRequestError } from "../core/client-factory";

interface PhoneCallResponse {
  callId: string;
  status: string;
}

export interface PhoneCall {
  id: string;
  status: string;
  fromNumber: string;
  toNumber: string;
  durationSeconds: number | null;
  startedAt: string | null;
  lastTranscriptSnippet?: string | null;
}

export interface TranscriptEntry {
  role: string;
  text: string;
}

interface PhoneCallListResponse {
  data: PhoneCall[];
  total: number;
  hasMore: boolean;
}

interface PhoneCallDetailResponse {
  call: PhoneCall;
  transcript: TranscriptEntry[] | null;
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
  mode?: "onhold" | "fire-and-forget";
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
