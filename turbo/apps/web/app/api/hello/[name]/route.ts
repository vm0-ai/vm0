import { NextRequest, NextResponse } from "next/server";

const greetings = {
  en: "Hello",
  es: "Hola",
  fr: "Bonjour",
  de: "Hallo",
} as const;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string }> },
) {
  const params = await context.params;
  const searchParams = request.nextUrl.searchParams;
  const lang = (searchParams.get("lang") as keyof typeof greetings) || "en";

  const name = params.name;

  if (!name) {
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
