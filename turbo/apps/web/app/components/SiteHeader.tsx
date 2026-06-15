import { auth } from "@clerk/nextjs/server";
import { Navbar } from "./Navbar";
import { canViewDocsForUser } from "../lib/docs";

export async function SiteHeader() {
  const { userId, orgId } = await auth();
  const showDocs = await canViewDocsForUser(userId, orgId);

  return (
    <div className="header-container">
      <Navbar initialIsSignedIn={!!userId} initialShowDocs={showDocs} />
    </div>
  );
}
