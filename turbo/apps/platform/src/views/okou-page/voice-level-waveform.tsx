import type { VoiceLevelSample } from "../../signals/voice-io/voice-draft-capture.ts";

export function VoiceLevelWaveform({
  samples,
}: {
  samples: readonly VoiceLevelSample[];
}) {
  return (
    <div
      className="flex h-6 min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden"
      data-voice-level-waveform
      aria-hidden="true"
    >
      {samples.map((sample) => {
        const height = 4 + sample.level * 4;
        return (
          <span
            key={sample.id}
            className="w-0.5 shrink-0 rounded-full bg-[#2E9E9F] transition-[height] duration-100 ease-linear"
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
}
