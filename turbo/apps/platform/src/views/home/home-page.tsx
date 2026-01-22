import { AppShell } from "../layout/app-shell.tsx";
import { OnboardingModal } from "./onboarding-modal.tsx";

export function HomePage() {
  return (
    <AppShell
      breadcrumb={["Get started"]}
      title="Welcome, You're in."
      subtitle="A few things you can explore with VM0"
    >
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50">
        <OnboardingModal />
      </div>
    </AppShell>
  );
}
