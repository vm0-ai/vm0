import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const locales = ["en", "de", "ja", "es"] as const;

const localeSchema = z.object({
  locale: z.enum(locales),
});

export async function POST(request: Request) {
  try {
    // Check authentication
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse and validate request body
    const body = await request.json();
    const { locale } = localeSchema.parse(body);

    // Update Clerk metadata
    const client = await clerkClient();
    await client.users.updateUser(userId, {
      publicMetadata: {
        locale,
      },
    });

    return NextResponse.json({ success: true, locale });
  } catch (error) {
    console.error("Failed to update locale:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid locale", details: error.errors },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
