import { redirect } from "next/navigation";
import { getUserId } from "./get-user-id";

/**
 * Require authentication for server components
 * Redirects to sign-in if not authenticated
 */
export async function requireUser(): Promise<string> {
  const userId = await getUserId();

  if (!userId) {
    redirect("/sign-in");
  }

  return userId;
}
