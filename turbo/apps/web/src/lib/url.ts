import { env } from "../env";

export function getPlatformUrl(): string {
  return env().NEXT_PUBLIC_PLATFORM_URL;
}
