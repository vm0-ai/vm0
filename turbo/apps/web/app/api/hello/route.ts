import { NextRequest, NextResponse } from "next/server";
import { HelloRequestSchema } from "@vm0/core";
import { z } from "zod";

const greetings = {
  en: "Hello",
  es: "Hola",
  fr: "Bonjour",
  de: "Hallo",
} as const;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = HelloRequestSchema.parse(body);

    const greeting = greetings[validatedData.language || "en"];
    const now = new Date();

    const response = {
      message: `${greeting}, ${validatedData.name}! Welcome to our API.`,
      timestamp: now.toISOString(),
      locale: validatedData.language || "en",
      metadata: {
        requestId: crypto.randomUUID(),
        version: "1.0.0",
        ...(validatedData.includeTime && {
          serverTime: now.toLocaleTimeString("en-US", {
            hour12: true,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        }),
      },
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Validation error",
          details: error.issues.map((err) => ({
            field: err.path.join("."),
            message: err.message,
          })),
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const lang = (searchParams.get("lang") as keyof typeof greetings) || "en";

  const urlParts = request.nextUrl.pathname.split("/");
  const name = urlParts[urlParts.length - 1];

  if (!name || name === "hello") {
    return NextResponse.json(
      { error: "Name parameter is required" },
      { status: 400 },
    );
  }

  const greeting = greetings[lang] || greetings.en;

  return NextResponse.json({
    greeting: `${greeting}, ${decodeURIComponent(name)}!`,
    name: decodeURIComponent(name),
    language: lang,
  });
}
