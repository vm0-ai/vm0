export async function fetchTtsAudio(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  text: string,
  signal: AbortSignal,
): Promise<Response | null> {
  const response = await fetchFn("/api/zero/voice-io/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 4096) }),
    signal,
  });

  if (!response.ok) {
    return null;
  }

  return response;
}
