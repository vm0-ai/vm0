import { env } from "./env";
export function webUrl(): string {
  return env("OKOU_WEB_URL");
}
