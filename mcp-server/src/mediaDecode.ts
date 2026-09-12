import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Frame } from "./ledDetect.js";

// The one module that owns ffmpeg subprocess calls and temp-file lifecycle for
// annotate_led_capture. Deliberately not unit-tested (per this repo's convention --
// see CONTRIBUTING.md's "Verifying changes" -- hardware/real-media behavior is
// live-verified, not covered by the pure-logic suite); ledDetect.ts and
// photoAnnotate.ts's window/remap math carry the unit tests instead.

const FFMPEG_INSTALL_HINT =
  "ffmpeg is required to decode video captures for annotate_led_capture. Install it " +
  "(e.g. `brew install ffmpeg` on macOS; it's added to the add-on's Docker image via " +
  "apk) and make sure it's on PATH.";

// Frame extraction is downscaled to this width (aspect-preserving) so a full-resolution
// phone video doesn't blow up decode time/memory -- LED-position detection only needs
// enough resolution to separate individual LEDs, not full fidelity.
const ANALYSIS_WIDTH = 640;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", (err) => {
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(FFMPEG_INSTALL_HINT) : err);
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export interface ExtractedFrame {
  /** Milliseconds from the start of the recording. */
  timestampMs: number;
  frame: Frame;
}

/**
 * Extracts frames from a video at `fps`, decoded to raw RGBA Frame buffers, in
 * chronological order.
 */
export async function extractVideoFrames(filePath: string, fps: number): Promise<ExtractedFrame[]> {
  const dir = await mkdtemp(join(tmpdir(), "identify-frames-"));
  try {
    const pattern = join(dir, "frame_%06d.png");
    await runFfmpeg(["-i", filePath, "-vf", `fps=${fps},scale=${ANALYSIS_WIDTH}:-2`, "-y", pattern]);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    if (files.length === 0) {
      throw new Error(`ffmpeg extracted zero frames from "${filePath}" -- is it a valid video file?`);
    }
    const frames: ExtractedFrame[] = [];
    for (let i = 0; i < files.length; i++) {
      const buf = await readFile(join(dir, files[i]));
      const png = PNG.sync.read(buf);
      frames.push({ timestampMs: (i * 1000) / fps, frame: { width: png.width, height: png.height, data: png.data } });
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Encodes a Frame back to a PNG buffer, for writing annotate_led_capture's output image. */
export function encodePng(frame: Frame): Buffer {
  const png = new PNG({ width: frame.width, height: frame.height });
  Buffer.from(frame.data).copy(png.data);
  return PNG.sync.write(png);
}
