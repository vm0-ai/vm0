import { env } from "./env";
export function apiBackendUrl(): string | undefined {
  return env("OKOU_API_BACKEND_URL");
}
