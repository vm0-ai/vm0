import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import {
  getModels,
  MODEL_PROVIDER_TYPES,
  type ModelProviderResponse,
} from "@vm0/core";

export interface ModelProviderSelection {
  modelProviderId: string;
  selectedModel: string;
}

interface ModelProviderPickerProps {
  providers: ModelProviderResponse[];
  value: ModelProviderSelection | null;
  onChange: (value: ModelProviderSelection | null) => void;
  placeholder?: string;
}

// Radix Select reserves the empty string for "no value" and throws if a
// SelectItem uses it, so use a sentinel to represent the inherit option.
const INHERIT_SENTINEL = "__inherit_default__";

function encodeValue(v: ModelProviderSelection | null): string {
  return v ? `${v.modelProviderId}::${v.selectedModel}` : INHERIT_SENTINEL;
}

function decodeValue(s: string): ModelProviderSelection | null {
  if (s === INHERIT_SENTINEL) {
    return null;
  }
  const idx = s.indexOf("::");
  return {
    modelProviderId: s.slice(0, idx),
    selectedModel: s.slice(idx + 2),
  };
}

export function ModelProviderPicker({
  providers,
  value,
  onChange,
  placeholder = "Inherit from org default",
}: ModelProviderPickerProps) {
  const options: { value: string; label: string }[] = [];

  for (const provider of providers) {
    const typeConfig = MODEL_PROVIDER_TYPES[provider.type];
    if (!typeConfig) {
      continue;
    }
    const providerLabel = typeConfig.label;
    const models = getModels(provider.type);
    if (!models || models.length === 0) {
      continue;
    }

    for (const model of models) {
      options.push({
        value: `${provider.id}::${model}`,
        label: `${providerLabel} — ${model}`,
      });
    }
  }

  return (
    <Select
      value={encodeValue(value)}
      onValueChange={(raw) => {
        onChange(decodeValue(raw));
      }}
    >
      <SelectTrigger className="h-9 w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT_SENTINEL}>{placeholder}</SelectItem>
        {options.map((opt) => {
          return (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
