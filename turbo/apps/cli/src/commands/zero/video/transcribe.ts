import { execFileSync } from "child_process";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Command } from "commander";
import { withErrorHandler } from "../../../lib/command";
import {
  downloadWebFile,
  transcribeAudio,
  type TranscribeAudioSegment,
} from "../../../lib/api/domains/web";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function formatTranscript(
  text: string,
  segments: readonly TranscribeAudioSegment[] | undefined,
): string {
  if (!segments || segments.length === 0) {
    return `## Transcript\n${text}`;
  }
  const lines = segments.map((s) => {
    const start = formatTime(s.start);
    const end = formatTime(s.end);
    return `[${start}-${end}] ${s.text.trim()}`;
  });
  return `## Transcript\n${lines.join("\n")}`;
}

export const transcribeCommand = new Command()
  .name("transcribe")
  .description(
    "Transcribe audio from a video file and output structured Markdown",
  )
  .option("--url <presigned-url>", "Pre-signed or public URL of the video file")
  .option("--file-id <id>", "Web file ID (alternative to --url)")
  .option(
    "--file <path>",
    "Local file path (alternative to --url or --file-id)",
  )
  .option(
    "--no-timestamps",
    "Output plain text only, without per-segment timestamps",
  )
  .addHelpText(
    "after",
    `
Examples:
  Transcribe from URL:      zero video transcribe --url "https://..."
  Transcribe a web file:    zero video transcribe --file-id abc-123-def
  Transcribe a local file:  zero video transcribe --file /tmp/video.mp4
  Plain text only:          zero video transcribe --url "https://..." --no-timestamps

Output:
  Structured Markdown printed to stdout:
    ## Transcript
    [00:02-00:05] First sentence here.
    [00:06-00:07] Second sentence here.

Notes:
  - Requires ffmpeg on PATH for audio extraction
  - Authenticates via ZERO_TOKEN
  - Audio is extracted before upload to stay within the 25 MB size limit
  - Uses the /api/zero/voice-io/stt endpoint (quota applies)`,
  )
  .action(
    withErrorHandler(
      async (options: {
        url?: string;
        fileId?: string;
        file?: string;
        timestamps: boolean;
      }) => {
        if (!options.url && !options.fileId && !options.file) {
          process.stderr.write(
            "Error: provide --url <presigned-url>, --file-id <id>, or --file <path>\n",
          );
          process.exit(1);
        }

        const tmpAudio = join(tmpdir(), `zero-audio-${Date.now()}.wav`);
        let tmpVideo: string | undefined;

        try {
          let videoPath: string;

          if (options.file) {
            videoPath = options.file;
          } else {
            tmpVideo = join(tmpdir(), `zero-video-${Date.now()}.mp4`);
            if (options.url) {
              execFileSync("curl", ["-sS", "-L", "-o", tmpVideo, options.url], {
                stdio: ["ignore", "ignore", "pipe"],
              });
            } else {
              await downloadWebFile(options.fileId as string, tmpVideo);
            }
            videoPath = tmpVideo;
          }

          execFileSync(
            "ffmpeg",
            [
              "-i",
              videoPath,
              "-vn",
              "-ar",
              "16000",
              "-ac",
              "1",
              "-c:a",
              "pcm_s16le",
              "-map_metadata",
              "-1",
              tmpAudio,
              "-y",
              "-loglevel",
              "error",
            ],
            { stdio: ["ignore", "ignore", "pipe"] },
          );

          const result = await transcribeAudio(tmpAudio, {
            verbose: options.timestamps !== false,
          });

          process.stdout.write(
            formatTranscript(result.text, result.segments) + "\n",
          );
        } finally {
          for (const path of [tmpAudio, tmpVideo]) {
            if (!path) continue;
            try {
              unlinkSync(path);
            } catch {
              // best-effort cleanup
            }
          }
        }
      },
    ),
  );
