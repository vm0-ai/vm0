import { useLoadable } from "ccstate-react";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { OrgProvidersTab } from "../../org-manage/org-providers-tab.tsx";
import { PersonalProvidersTab } from "../../preferences/personal-providers-tab.tsx";

export function ModelSection() {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  return (
    <div className="flex flex-col gap-10">
      {isAdmin && <OrgProvidersTab />}
      <PersonalProvidersTab />
    </div>
  );
}
