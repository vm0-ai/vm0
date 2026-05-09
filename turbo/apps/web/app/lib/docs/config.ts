import { env } from "../../../src/env";

export function getDocsBaseUrl(): string {
  return env().NEXT_PUBLIC_BASE_URL || "https://www.vm0.ai";
}
