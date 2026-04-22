import type { ReactNode } from "react";
import { useGet } from "ccstate-react";
import { IconAlertCircle, IconLock, IconX } from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { searchParams$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { VM0Logo } from "../components/vm0-logo.tsx";

type ReasonKind = "transient" | "auth" | "broken";

interface ReasonInfo {
  kind: ReasonKind;
  title: string;
  body: string;
}

function resolveReason(reason: string | null): ReasonInfo {
  switch (reason) {
    case "billing_unavailable": {
      return {
        kind: "transient",
        title: "Billing is temporarily unavailable",
        body: "Our payment system isn't available right now. Please try again in a few minutes.",
      };
    }
    case "admin_required": {
      return {
        kind: "auth",
        title: "Admin access required",
        body: "Only organization admins can redeem campaign credits. Ask an admin in your org to open the link instead.",
      };
    }
    case "campaign_misconfigured": {
      return {
        kind: "broken",
        title: "This offer isn't available",
        body: "The promo code may have expired, reached its redemption limit, or been removed. If you believe this is a mistake, contact support.",
      };
    }
    default: {
      return {
        kind: "broken",
        title: "Something went wrong",
        body: "We couldn't complete your redemption. Please try again or contact support.",
      };
    }
  }
}

function ReasonIcon({ kind }: { kind: ReasonKind }): ReactNode {
  switch (kind) {
    case "transient": {
      return (
        <IconAlertCircle
          size={40}
          className="text-muted-foreground opacity-70"
        />
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

export function RedeemErrorPage() {
  const params = useGet(searchParams$);
  const info = resolveReason(params.get("reason"));

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background px-6">
      <div className="flex w-[500px] max-w-full flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <VM0Logo />
        <div className="flex flex-col items-center gap-4">
          <ReasonIcon kind={info.kind} />
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {info.title}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {info.body}
          </p>
        </div>
        <Button className="w-full" asChild>
          <Link pathname={ROUTES.home}>Back to home</Link>
        </Button>
      </div>
    </div>
  );
}
