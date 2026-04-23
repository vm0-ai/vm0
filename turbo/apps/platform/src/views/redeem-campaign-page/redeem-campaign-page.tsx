import type { ReactNode } from "react";
import { useGet, useLastLoadable } from "ccstate-react";
import {
  IconCheck,
  IconGift,
  IconLoader2,
  IconLock,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import type { RedeemResponse } from "@vm0/core/contracts/zero-billing";
import {
  redeemResponse$,
  redeemStripeSuccess$,
} from "../../signals/redeem-campaign/redeem-campaign-signals.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { clerk$ } from "../../signals/auth.ts";
import { Link } from "../router/link.tsx";
import { VM0Logo } from "../components/vm0-logo.tsx";

type CardKind = "ready" | "granted" | "processing" | "auth" | "broken";

interface CardInfo {
  kind: CardKind;
  title: string;
  body: string;
}

function resolveCard(
  response: RedeemResponse | null,
  stripeSuccess: boolean,
  orgName: string,
): CardInfo {
  if (stripeSuccess) {
    return {
      kind: "granted",
      title: "Payment successful",
      body: `Your credits are on the way to ${orgName}. Open the dashboard to see your new balance.`,
    };
  }
  if (!response) {
    return {
      kind: "broken",
      title: "Something went wrong",
      body: "We couldn't complete your redemption. Please try again or contact support.",
    };
  }
  switch (response.status) {
    case "ready": {
      return {
        kind: "ready",
        title: "Claim your credits",
        body: `Complete checkout to add these credits to ${orgName}'s balance.`,
      };
    }
    case "already_granted": {
      return {
        kind: "granted",
        title: "You've already redeemed this offer",
        body: `Your credits are already in ${orgName}'s account. Head back to the app to start using them.`,
      };
    }
    case "processing": {
      return {
        kind: "processing",
        title: "Payment received",
        body: `We're applying your credits to ${orgName} now. This usually takes a few seconds — refresh in a moment to see the updated balance.`,
      };
    }
    case "error": {
      switch (response.reason) {
        case "billing_unavailable": {
          return {
            kind: "broken",
            title: "Billing is temporarily unavailable",
            body: "Our payment system isn't available right now. Please try again in a few minutes.",
          };
        }
        case "admin_required": {
          return {
            kind: "auth",
            title: "Admin access required",
            body: `Only organization admins can redeem campaign credits for ${orgName}. Ask an admin in your org to open the link instead.`,
          };
        }
        case "campaign_misconfigured": {
          return {
            kind: "broken",
            title: "This offer isn't available",
            body: "The promo code may have expired, reached its redemption limit, or been removed. If you believe this is a mistake, contact support.",
          };
        }
      }
    }
  }
}

function CardIcon({ kind }: { kind: CardKind }): ReactNode {
  switch (kind) {
    case "ready": {
      return <IconGift size={40} className="text-foreground opacity-80" />;
    }
    case "granted": {
      return <IconCheck size={40} className="text-green-600 opacity-80" />;
    }
    case "processing": {
      return (
        <IconLoader2 size={40} className="animate-spin text-muted-foreground" />
      );
    }
    case "auth": {
      return (
        <IconLock size={40} className="text-muted-foreground opacity-70" />
      );
    }
    case "broken": {
      return <IconX size={40} className="text-destructive opacity-70" />;
    }
  }
}

function PrimaryAction({
  response,
  stripeSuccess,
}: {
  response: RedeemResponse | null;
  stripeSuccess: boolean;
}): ReactNode {
  if (!stripeSuccess && response?.status === "ready") {
    // Render as an <a> (via asChild) so the browser handles cmd/ctrl+click,
    // middle-click, and right-click → "open in new tab" natively. A plain
    // onClick with `window.location.assign` swallows those modifier clicks.
    const checkoutUrl = response.checkoutUrl;
    return (
      <Button className="w-full" asChild>
        <a href={checkoutUrl}>Redeem credits</a>
      </Button>
    );
  }

  // `granted` / `processing` / `stripeSuccess` send the user to the dashboard
  // where the new credit balance is visible. Error cards just send them home.
  return (
    <Button className="w-full" asChild>
      <Link pathname={ROUTES.home}>Back to VM0</Link>
    </Button>
  );
}

export function RedeemCampaignPage() {
  const response = useGet(redeemResponse$);
  const stripeSuccess = useGet(redeemStripeSuccess$);
  const clerkLoadable = useLastLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const orgName = clerk?.organization?.name ?? "your organization";
  const info = resolveCard(response, stripeSuccess, orgName);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 md:-translate-x-[128px]">
      <div className="flex w-[500px] max-w-full flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <VM0Logo />
        <div className="flex flex-col items-center gap-4">
          <CardIcon kind={info.kind} />
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {info.title}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {info.body}
          </p>
        </div>
        <PrimaryAction response={response} stripeSuccess={stripeSuccess} />
      </div>
    </div>
  );
}
