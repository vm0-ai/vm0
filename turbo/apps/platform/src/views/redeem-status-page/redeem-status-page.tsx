import type { ReactNode } from "react";
import { useGet } from "ccstate-react";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { searchParams$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { VM0Logo } from "../components/vm0-logo.tsx";

type StateKind = "granted" | "processing";

interface StateInfo {
  kind: StateKind;
  title: string;
  body: string;
}

function resolveState(state: string | null): StateInfo {
  switch (state) {
    case "processing": {
      return {
        kind: "processing",
        title: "Payment received",
        body: "We're applying your credits now. This usually takes a few seconds — refresh in a moment to see the updated balance.",
      };
    }
    case "redeemed": {
      return {
        kind: "granted",
        title: "Payment successful",
        body: "Your credits are on the way. Open the dashboard to see your new balance.",
      };
    }
    case "already_redeemed":
    default: {
      return {
        kind: "granted",
        title: "You've already redeemed this offer",
        body: "Your credits are in your account. Head back to the app to start using them.",
      };
    }
  }
}

function StateIcon({ kind }: { kind: StateKind }): ReactNode {
  switch (kind) {
    case "granted": {
      return <IconCheck size={40} className="text-green-600 opacity-80" />;
    }
    case "processing": {
      return (
        <IconLoader2 size={40} className="animate-spin text-muted-foreground" />
      );
    }
  }
}

export function RedeemStatusPage() {
  const params = useGet(searchParams$);
  const info = resolveState(params.get("state"));

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background px-6">
      <div className="flex w-[500px] max-w-full flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <VM0Logo />
        <div className="flex flex-col items-center gap-4">
          <StateIcon kind={info.kind} />
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {info.title}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {info.body}
          </p>
        </div>
        <Button className="w-full" asChild>
          <Link pathname={ROUTES.home}>Open dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
