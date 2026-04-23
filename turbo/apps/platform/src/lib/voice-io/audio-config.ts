type NoiseReduction = "near_field" | "far_field";

interface AudioConfig {
  constraints: MediaTrackConstraints;
  noiseReduction: NoiseReduction;
}

/**
 * Resolve audio constraints + OpenAI Realtime noise-reduction hint for the
 * current device. Called once per connection so plugging in headphones between
 * sessions takes effect on the next connect.
 *
 * Mobile speakerphone is the edge case this guards against:
 * - AGC ("autoGainControl") pumps mic gain during AI speech pauses, making the
 *   next echo burst louder. Desktop is fine because hardware AEC handles it;
 *   wired/BT audio is fine because there's no acoustic loop. Mobile without
 *   external audio is the one scenario where AGC amplifies the loop.
 * - OpenAI's `far_field` noise reduction is tuned for conference-style mic
 *   placements; `near_field` is better for phone-to-mouth speakerphone where
 *   the mic is close and echo dominates background noise.
 *
 * Also flips `navigator.audioSession.type` to "play-and-record" when
 * supported (Chrome Android 116+, Safari iOS 17+), which routes audio through
 * the OS phone-call path with hardware AEC for speakerphone.
 */
export async function resolveAudioConfig(): Promise<AudioConfig> {
  if ("audioSession" in navigator) {
    (navigator as { audioSession?: { type: string } }).audioSession!.type =
      "play-and-record";
  }

  const isMobile =
    navigator.maxTouchPoints > 0 && /Mobi|Android/i.test(navigator.userAgent);

  const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  const hasExternalAudio = devices.some((d) => {
    return (
      d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== ""
    );
  });

  const speakerRisk = isMobile && !hasExternalAudio;

  return {
    constraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: !speakerRisk,
    },
    noiseReduction: speakerRisk ? "near_field" : "far_field",
  };
}
