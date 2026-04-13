import { useGet, useSet, useLastResolved, useLoadable } from "ccstate-react";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { Link } from "../router/link.tsx";
import {
  orgSkills$,
  boundCustomSkills$,
  pendingSkillNames$,
  toggleAgentSkill$,
} from "../../signals/zero-page/zero-job-detail.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ROUTES } from "../../signals/route-paths.ts";

export function ZeroSkillsTab() {
  const skillsLoadable = useLoadable(orgSkills$);
  const bound = useLastResolved(boundCustomSkills$) ?? new Set<string>();
  const pending = useLastResolved(pendingSkillNames$) ?? new Set<string>();
  const toggle = useSet(toggleAgentSkill$);
  const signal = useGet(pageSignal$);
  const adminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;

  if (skillsLoadable.state === "loading") {
    return (
      <div className="mx-auto max-w-[900px] space-y-3 animate-pulse">
        <div className="h-12 w-full rounded bg-muted/30" />
        <div className="h-12 w-full rounded bg-muted/30" />
        <div className="h-12 w-full rounded bg-muted/30" />
      </div>
    );
  }

  if (skillsLoadable.state === "hasError") {
    return (
      <div className="mx-auto max-w-[900px]">
        <p className="text-sm text-destructive">Failed to load skills.</p>
      </div>
    );
  }

  const skills = skillsLoadable.data;
  if (skills.length === 0) {
    return (
      <div className="mx-auto max-w-[900px] py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No custom skills in your org yet.
        </p>
        {isAdmin ? (
          <Link
            pathname={ROUTES.skills}
            className="text-sm text-primary underline mt-2 inline-block"
          >
            Manage skills in /skills
          </Link>
        ) : (
          <p className="text-xs text-muted-foreground mt-2">
            Ask an org admin to create one.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[900px] space-y-1">
      {skills.map((skill) => {
        return (
          <SkillRow
            key={skill.name}
            name={skill.name}
            displayName={skill.displayName}
            description={skill.description}
            checked={bound.has(skill.name)}
            loading={pending.has(skill.name)}
            onToggle={(next) => {
              detach(
                toggle({ skillName: skill.name, enabled: next }, signal),
                Reason.DomCallback,
                "toggle-skill",
              );
            }}
          />
        );
      })}
    </div>
  );
}

function SkillRow({
  name,
  displayName,
  description,
  checked,
  loading,
  onToggle,
}: {
  name: string;
  displayName: string | null;
  description: string | null;
  checked: boolean;
  loading: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 bg-card px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {displayName ?? name}
          </span>
          <span className="text-xs text-muted-foreground truncate">{name}</span>
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {description}
          </p>
        )}
      </div>
      <LoadingSwitch
        checked={checked}
        loading={loading}
        onCheckedChange={onToggle}
        ariaLabel={`Toggle skill ${name}`}
      />
    </div>
  );
}
