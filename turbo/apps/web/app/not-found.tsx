import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page Not Found",
  description: "The page you are looking for does not exist.",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center font-[family-name:var(--font-noto-sans)]">
      <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
        404
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">Page not found</h1>
      <p className="mt-3 text-base text-muted-foreground">
        The page you are looking for doesn&apos;t exist or has been moved.
      </p>
      <Link
        href="/en"
        className="mt-8 inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        Back to home
      </Link>
    </div>
  );
}
