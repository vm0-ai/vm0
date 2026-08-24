import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@okouai/ui";
import { useGet } from "ccstate-react";

import { authV2SignInSignals$ } from "../../../signals/auth-v2/sign-in-flow.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { Link } from "../../router/link.tsx";
import { SignInCardContent } from "./sign-in-content.tsx";
import { signInCardDescription, useAuthV2SignInCopy } from "./sign-in-copy.ts";

export function AuthV2SignInCard() {
  const copy = useAuthV2SignInCopy();
  const signals = useGet(authV2SignInSignals$);
  const flowState = useGet(signals.state$);
  return (
    <Card className="w-full max-w-md rounded-3xl" data-testid="app-auth-v2">
      <CardHeader className="items-center text-center">
        <h1 className="text-lg font-medium text-foreground">
          {copy.signInTitle}
        </h1>
        <CardDescription>
          {signInCardDescription(flowState, copy)}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <SignInCardContent copy={copy} signals={signals} state={flowState} />
      </CardContent>
      <CardFooter className="justify-center">
        <Button asChild size="sm" variant="link">
          <Link
            pathname={ROUTES.signIn}
            options={{
              hash: location.hash,
              searchParams: new URLSearchParams(location.search),
            }}
          >
            {copy.legacySignIn}
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
