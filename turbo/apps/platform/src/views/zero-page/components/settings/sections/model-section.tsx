import { useLoadable } from "ccstate-react";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { OrgProvidersTab } from "../../org-manage/org-providers-tab.tsx";
import { PersonalProvidersTab } from "../../preferences/personal-providers-tab.tsx";
import { SettingsSectionHeading } from "../settings-section-heading.tsx";

export function ModelSection() {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  return (
    <div className="flex flex-col gap-10">
      {isAdmin && (
        <section className="flex flex-col gap-4">
          <SettingsSectionHeading
            title="Workspace Model"
            description="Models configured for everyone in the workspace. Set the default and route each model."
          />
          <OrgProvidersTab />
        </section>
      )}

      <section className="flex flex-col gap-4">
        <SettingsSectionHeading
          title="Personal Model"
          description="Models that only you can use, configured with your own credentials."
        />
        <PersonalProvidersTab />
      </section>
    </div>
  );
}
