import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: ["/((?!_next|_vercel|assets|.*\\..*|api|v1).*)"],
};
