import { SubscriptionDetailsButton } from "@clerk/clerk-react/experimental";
import { IconReceipt } from "@tabler/icons-react";
import { VM0ClerkProvider } from "./clerk-provider";

export function VM0SubscriptionDetailsButton() {
  return (
    <VM0ClerkProvider>
      <SubscriptionDetailsButton
        subscriptionDetailsProps={{
          appearance: {
            variables: {
              colorPrimary: "#ED4E01",
              colorBackground: "#FFFCF9",
              borderRadius: "0.5rem",
              fontFamily:
                "Noto Sans, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
            },
            elements: {
              card: {
                boxShadow: "none",
              },
              subscriptionDetailsCard: {
                boxShadow: "none",
                border: "1px solid #E8E2DD",
              },
              subscriptionDetailsCardBody: {
                boxShadow: "none",
              },
              drawer: {
                backgroundColor: "#F9F4EF",
              },
              drawerContent: {
                backgroundColor: "#FFFCF9",
              },
              drawerHeader: {
                backgroundColor: "#F9F4EF !important",
                borderBottom: "1px solid #E8E2DD !important",
              },
              drawerTitle: "text-gray-950",
              headerBox: "bg-[#F9F4EF]",
              headerTitle: "text-gray-950",
              headerSubtitle: "text-gray-800",
              formButtonPrimary:
                "bg-primary-800 hover:bg-primary-900 text-white font-medium",
              footerActionLink: "text-primary-800 hover:text-primary-900",
            },
          },
        }}
      >
        <button className="flex w-full items-center gap-2 p-2 h-9 rounded-lg text-sidebar-foreground hover:bg-sidebar-accent transition-colors">
          <IconReceipt size={16} className="shrink-0" />
          <span className="text-sm leading-5">Bill</span>
        </button>
      </SubscriptionDetailsButton>
    </VM0ClerkProvider>
  );
}
