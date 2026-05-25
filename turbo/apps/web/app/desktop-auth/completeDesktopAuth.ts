"use client";

export async function completeDesktopAuth(
  getToken: (options?: {
    readonly skipCache?: boolean;
  }) => Promise<string | null>,
): Promise<void> {
  const token = await getToken({ skipCache: true });
  if (!token) {
    throw new Error("Missing desktop session token.");
  }

  await window.vm0DesktopAuth?.completeSignIn?.({ token });
}
