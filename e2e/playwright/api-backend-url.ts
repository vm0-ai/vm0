const CANONICAL_API_BACKEND_URL_KEY = "OKOU_API_BACKEND_URL";

type ApiBackendUrlEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveApiBackendUrl(
  environment: ApiBackendUrlEnvironment = process.env,
): string {
  const value = environment[CANONICAL_API_BACKEND_URL_KEY];
  if (!value) {
    throw new Error(
      `E2E API backend URL is required: canonical_key=${CANONICAL_API_BACKEND_URL_KEY} state=missing`,
    );
  }
  return value;
}
