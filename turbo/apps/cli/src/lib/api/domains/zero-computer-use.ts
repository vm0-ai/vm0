import { initClient } from "@ts-rest/core";
import type {
  ComputerUseCommandCreateResponse,
  ComputerUseCommandResponse,
  ComputerUseReadCommandKind,
  ComputerUseWriteCommandKind,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import {
  zeroComputerUseCommandContract,
  zeroComputerUseWriteCommandContract,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import {
  ApiRequestError,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";

function normalizeConfiguredUrl(value: string): string {
  return value.startsWith("http") ? value : `https://${value}`;
}

function resolveComputerUseApiBaseUrl(baseUrl: string): string {
  const override = process.env.VM0_API_BACKEND_URL;
  if (override) {
    return normalizeConfiguredUrl(override).replace(/\/$/, "");
  }

  const url = new URL(baseUrl);
  if (url.hostname === "www.vm0.ai" || url.hostname === "app.vm0.ai") {
    url.hostname = "api.vm0.ai";
  }
  return url.toString().replace(/\/$/, "");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  return headers;
}

async function getComputerUseClientConfig() {
  const baseUrl = resolveComputerUseApiBaseUrl(await getBaseUrl());
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  return {
    baseUrl,
    baseHeaders: buildHeaders(token),
    jsonQuery: false as const,
  };
}

interface ComputerUseCommandParams<
  Kind extends ComputerUseReadCommandKind | ComputerUseWriteCommandKind,
> {
  readonly kind: Kind;
  readonly app?: string;
  readonly snapshotId?: string;
  readonly elementId?: string;
  readonly elementIndex?: number;
  readonly x?: number;
  readonly y?: number;
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: number;
  readonly direction?: "up" | "down" | "left" | "right";
  readonly pages?: number;
  readonly value?: string;
  readonly text?: string;
  readonly key?: string;
  readonly action?: string;
  readonly timeoutMs?: number;
}

function commandBody<
  Kind extends ComputerUseReadCommandKind | ComputerUseWriteCommandKind,
>(params: ComputerUseCommandParams<Kind>) {
  return {
    kind: params.kind,
    timeoutMs: params.timeoutMs ?? 15_000,
    ...(params.app ? { app: params.app } : {}),
    ...(params.snapshotId ? { snapshotId: params.snapshotId } : {}),
    ...(params.elementId ? { elementId: params.elementId } : {}),
    ...(params.elementIndex !== undefined
      ? { elementIndex: params.elementIndex }
      : {}),
    ...(params.x !== undefined ? { x: params.x } : {}),
    ...(params.y !== undefined ? { y: params.y } : {}),
    ...(params.button ? { button: params.button } : {}),
    ...(params.clickCount !== undefined
      ? { clickCount: params.clickCount }
      : {}),
    ...(params.direction ? { direction: params.direction } : {}),
    ...(params.pages !== undefined ? { pages: params.pages } : {}),
    ...(params.value !== undefined ? { value: params.value } : {}),
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...(params.key ? { key: params.key } : {}),
    ...(params.action ? { action: params.action } : {}),
  };
}

export async function createComputerUseReadCommand(
  params: ComputerUseCommandParams<ComputerUseReadCommandKind>,
): Promise<ComputerUseCommandCreateResponse> {
  const config = await getComputerUseClientConfig();
  const client = initClient(zeroComputerUseCommandContract, config);
  const result = await client.create({ body: commandBody(params) });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create computer-use command");
}

export async function createComputerUseWriteCommand(
  params: ComputerUseCommandParams<ComputerUseWriteCommandKind>,
): Promise<ComputerUseCommandCreateResponse> {
  const config = await getComputerUseClientConfig();
  const client = initClient(zeroComputerUseWriteCommandContract, config);
  const result = await client.create({ body: commandBody(params) });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create computer-use write command");
}

export async function getComputerUseCommand(
  commandId: string,
): Promise<ComputerUseCommandResponse> {
  const config = await getComputerUseClientConfig();
  const client = initClient(zeroComputerUseCommandContract, config);
  const result = await client.get({ params: { commandId } });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get computer-use command");
}
