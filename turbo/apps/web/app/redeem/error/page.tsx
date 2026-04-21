import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Redemption Error",
  robots: { index: false, follow: false },
};

interface ReasonInfo {
  title: string;
  body: string;
}

const REASONS: Record<string, ReasonInfo> = {
  billing_unavailable: {
    title: "Billing is temporarily unavailable",
    body: "Our payment system isn't available right now. Please try again in a few minutes.",
  },
  no_active_org: {
    title: "No active organization",
    body: "Switch to an organization and open the redemption link again.",
  },
  admin_required: {
    title: "Admin access required",
    body: "Only organization admins can redeem campaign credits. Ask an admin to open the link instead.",
  },
  campaign_misconfigured: {
    title: "This campaign is misconfigured",
    body: "We couldn't start the checkout session. The team has been notified — please try again later or contact support.",
  },
};

const FALLBACK: ReasonInfo = {
  title: "Something went wrong",
  body: "We couldn't complete your redemption. Please try again or contact support.",
};

interface Props {
  searchParams: Promise<{ reason?: string }>;
}

export default async function RedeemError({ searchParams }: Props) {
  const { reason } = await searchParams;
  const info = REASONS[reason ?? ""] ?? FALLBACK;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center font-[family-name:var(--font-noto-sans)]">
      <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
        Redemption
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">{info.title}</h1>
      <p className="mt-3 max-w-md text-base text-muted-foreground">
        {info.body}
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        Back to home
      </Link>
    </div>
  );
}
