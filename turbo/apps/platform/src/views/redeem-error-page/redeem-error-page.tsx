import type { ReactNode } from "react";
import { useGet } from "ccstate-react";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconLock,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { searchParams$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";

type ReasonKind = "transient" | "action" | "auth" | "broken";

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
    case "no_active_org": {
      return {
        kind: "action",
        title: "No active organization",
        body: "Switch to an organization and open the redemption link again.",
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
        title: "This campaign is misconfigured",
        body: "We couldn't start the checkout session. The team has been notified — please try again later or contact support.",
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
    case "action": {
      return (
        <IconAlertTriangle size={40} className="text-orange-500 opacity-70" />
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
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-6 rounded-[20px] border border-border bg-background px-8 py-10">
        <ReasonIcon kind={info.kind} />
        <div className="flex flex-col items-center gap-2">
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
