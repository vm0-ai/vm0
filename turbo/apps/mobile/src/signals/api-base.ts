export function resolveApiBase(_preferShadow: boolean): string {
  return process.env.EXPO_PUBLIC_API_URL ?? "https://api.vm0.ai";
}
