"use client";

export async function completeDesktopAuth(
  getToken: (options?: {
    readonly skipCache?: boolean;
  }) => Promise<string | null>,
): Promise<string> {
  const token = await getToken({ skipCache: true });
  if (!token) {
    throw new Error("Missing desktop session token.");
  }

  const completeSignIn = window.vm0DesktopAuth?.completeSignIn;
  if (!completeSignIn) {
    throw new Error("Desktop sign-in bridge is unavailable.");
  }

  await completeSignIn({ token });
  return token;
}

export async function completeDesktopAuthHandoff(
  token: string,
  handoffId: string,
): Promise<void> {
  const response = await fetch(
    `/api/desktop-auth/handoff/${handoffId}/complete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    throw new Error("Desktop sign-in completion failed.");
  }
}
