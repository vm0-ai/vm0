import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@okouai/ui";

import {
  PersonalUsageRecord,
  TeamUsageRecord,
  UsageRangeSelect,
} from "../../preferences/personal-usage-record.tsx";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import {
  creditBalanceTab$,
  myUsageRange$,
  setCreditBalanceTab$,
  setMyUsageRange$,
  setTeamUsageRange$,
  teamUsageRange$,
  type CreditBalanceTab,
} from "../../../../../signals/okou-page/settings/personal-usage-record.ts";

export function UsageRecordsSection() {
  const { t } = useTranslation();
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const tab = useGet(creditBalanceTab$);
  const setTab = useSet(setCreditBalanceTab$);
  const myRange = useGet(myUsageRange$);
  const teamRange = useGet(teamUsageRange$);
  const setMyRange = useSet(setMyUsageRange$);
  const setTeamRange = useSet(setTeamUsageRange$);

  // Team usage is admin data. Members still get their own records, which is the
  // whole point of the section for them.
  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <UsageRangeSelect value={myRange} onChange={setMyRange} />
        </div>
        <PersonalUsageRecord range={myRange} />
      </div>
    );
  }

  const activeRange = tab === "team" ? teamRange : myRange;
  const setActiveRange = tab === "team" ? setTeamRange : setMyRange;

  return (
    <div className="flex flex-col gap-4">
      {/* One compact header row: tabs on the left, range filter on the right. */}
      <div className="flex items-center justify-between gap-3">
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as CreditBalanceTab);
          }}
        >
          <TabsList>
            <TabsTrigger value="mine">
              {t(($) => {
                return $.usage.records.myUsage;
              })}
            </TabsTrigger>
            <TabsTrigger value="team">
              {t(($) => {
                return $.usage.records.teamUsage;
              })}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <UsageRangeSelect value={activeRange} onChange={setActiveRange} />
      </div>
      {tab === "mine" ? (
        <PersonalUsageRecord range={myRange} />
      ) : (
        <TeamUsageRecord range={teamRange} />
      )}
    </div>
  );
}
