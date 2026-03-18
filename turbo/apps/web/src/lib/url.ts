import { env } from "../env";

export function getAppUrl(): string {
  return env().NEXT_PUBLIC_APP_URL;
}
