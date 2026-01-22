import { useSet, useLoadable } from "ccstate-react";
import { Button } from "@vm0/ui";
import { scope$ } from "../../signals/scope.ts";
import { navigateInReact$ } from "../../signals/route.ts";

export function OnboardingPage() {
  const scopeLoadable = useLoadable(scope$);
  const navigate = useSet(navigateInReact$);

  const handleContinue = () => {
    navigate("/");
  };

  const isCreating = scopeLoadable.state === "loading";
  const isReady = scopeLoadable.state === "hasData" && scopeLoadable.data;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50">
      {isCreating && (
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600" />
          <p className="text-lg text-gray-600">Setting up your workspace...</p>
        </div>
      )}

      {isReady && (
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900">Welcome onboard!</h1>
          <p className="mt-4 text-lg text-gray-600">Your workspace is ready.</p>
          <div className="mt-8">
            <Button onClick={handleContinue} size="lg">
              Get Started
            </Button>
          </div>
        </div>
      )}

      {scopeLoadable.state === "hasError" && (
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">
            Something went wrong
          </h1>
          <p className="mt-4 text-gray-600">
            Failed to set up your workspace. Please try again.
          </p>
        </div>
      )}
    </div>
  );
}
