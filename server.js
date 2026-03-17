import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import "dotenv/config";
import express from "express";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
dotenv.config();

const execFileAsync = promisify(execFile);

const {
  PORT = 3000,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!SUPABASE_URL) {
  throw new Error("Missing SUPABASE_URL");
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
}

if (!ffmpegPath) {
  throw new Error("ffmpeg-static could not find an ffmpeg binary");
}

const ffprobePath = ffprobe.path;

if (!ffprobePath) {
  throw new Error("ffprobe-static could not find an ffprobe binary");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.send("Pawprints merge service is running");
});

async function downloadFile(url, targetPath) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
}

async function getMediaDuration(mediaPath) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    mediaPath,
  ];

  const { stdout } = await execFileAsync(ffprobePath, args);
  const duration = Number(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine media duration for ${mediaPath}`);
  }

  return duration;
}

async function mergeVideoAndAudio({
  videoPath,
  audioPath,
  outputPath,
}) {
  const videoDuration = await getMediaDuration(videoPath);
  const audioDuration = await getMediaDuration(audioPath);

  console.log("[merge] durations", {
    videoDuration,
    audioDuration,
  });

  const args = [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-af",
    `apad=whole_dur=${videoDuration}`,
    "-t",
    String(videoDuration),
    "-movflags",
    "+faststart",
    outputPath,
  ];

  const { stdout, stderr } = await execFileAsync(ffmpegPath, args);

  const finalDuration = await getMediaDuration(outputPath);

  console.log("[merge] final duration check", {
    videoDuration,
    audioDuration,
    finalDuration,
  });

  return {
    stdout,
    stderr,
    videoDuration,
    audioDuration,
    finalDuration,
  };
}

async function markExportFailed(jobId, message) {
  await supabase
    .from("memory_jobs")
    .update({
      export_status: "failed",
      export_error_message: message,
    })
    .eq("id", jobId);
}

app.post("/merge-memory-media", async (req, res) => {
  const { jobId } = req.body ?? {};

  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }

  let tempDir = null;

  try {
    const { data: job, error: jobError } = await supabase
      .from("memory_jobs")
      .select(
        "id, output_url, voice_audio_url, final_video_url, export_status"
      )
      .eq("id", jobId)
      .single();

    if (jobError) {
      throw new Error(`Failed to load memory job: ${jobError.message}`);
    }

    if (!job) {
      return res.status(404).json({ error: "Memory job not found" });
    }

    if (job.final_video_url) {
      return res.json({
        success: true,
        final_video_url: job.final_video_url,
        cached: true,
      });
    }

    if (!job.output_url) {
      return res.status(400).json({
        error: "This memory does not have a generated video yet.",
      });
    }

    if (!job.voice_audio_url) {
      return res.status(400).json({
        error: "This memory does not have a voice recording yet.",
      });
    }

    const { error: processingError } = await supabase
      .from("memory_jobs")
      .update({
        export_status: "processing",
        export_error_message: null,
      })
      .eq("id", jobId);

    if (processingError) {
      throw new Error(
        `Failed to update export_status: ${processingError.message}`
      );
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pawprints-"));

    const videoPath = path.join(tempDir, "input-video.mp4");
    const audioPath = path.join(tempDir, "input-audio.m4a");
    const outputPath = path.join(tempDir, "final-memory.mp4");

    await downloadFile(job.output_url, videoPath);
    await downloadFile(job.voice_audio_url, audioPath);

    const mergeResult = await mergeVideoAndAudio({
      videoPath,
      audioPath,
      outputPath,
    });

    console.log("[merge] ffmpeg completed", {
      jobId,
      videoDuration: mergeResult.videoDuration,
      audioDuration: mergeResult.audioDuration,
      finalDuration: mergeResult.finalDuration,
      stderr: mergeResult.stderr?.slice(0, 1500) ?? "",
    });

    const mergedBuffer = await fs.readFile(outputPath);
    const storagePath = `${jobId}/final-${Date.now()}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from("generated")
      .upload(storagePath, mergedBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    const { data: publicUrlData } = supabase.storage
      .from("generated")
      .getPublicUrl(storagePath);

    const finalVideoUrl = publicUrlData?.publicUrl;

    if (!finalVideoUrl) {
      throw new Error("Could not create public URL for merged video");
    }

    const { error: updateError } = await supabase
      .from("memory_jobs")
      .update({
        final_video_url: finalVideoUrl,
        export_status: "completed",
        export_error_message: null,
      })
      .eq("id", jobId);

    if (updateError) {
      throw new Error(`Failed to save final video URL: ${updateError.message}`);
    }

    return res.json({
      success: true,
      final_video_url: finalVideoUrl,
      cached: false,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown merge error";

    console.error("[merge] error", { jobId, message });

    try {
      await markExportFailed(jobId, message);
    } catch {}

    return res.status(500).json({
      error: message,
    });
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`Merge service running on port ${PORT}`);
});