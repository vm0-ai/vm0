import { auth } from "@clerk/nextjs/server";
import Navbar from "./Navbar";

export default async function SiteHeader() {
  const { userId } = await auth();

  return (
    <div className="header-container">
      <Navbar initialIsSignedIn={!!userId} />
    </div>
  );
}
