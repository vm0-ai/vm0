import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { getUserId } from "../../../../src/lib/auth/get-user-id";

export async function GET() {
  const userId = await getUserId();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const email = user.emailAddresses.find(
      (e) => e.id === user.primaryEmailAddressId,
    )?.emailAddress;

    return NextResponse.json({
      userId: user.id,
      email: email || "",
    });
  } catch (error) {
    console.error("Failed to get user info:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
