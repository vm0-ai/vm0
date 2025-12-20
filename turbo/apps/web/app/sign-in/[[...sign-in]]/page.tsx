import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { isCommunityEdition } from "../../../src/lib/edition";

export default function SignInPage() {
  // Community Edition: redirect to dashboard (no login needed)
  if (isCommunityEdition()) {
    redirect("/dashboard");
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "linear-gradient(to bottom, #f3f4f6, #ffffff)",
      }}
    >
      <SignIn />
    </div>
  );
}
