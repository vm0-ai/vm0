import { env } from "../env";

export function getAppUrl(): string {
  return env().NEXT_PUBLIC_PLATFORM_URL;
}
