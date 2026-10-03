/*
=========================================================
 RECAP ONE CLIP V3.1
 Myanmar AI Recap Studio
=========================================================
*/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ffmpegPath = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const googleTTS = require("google-tts-api");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const PORT = process.env.PORT || 10000;

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const TEMP_DIR = path.join(ROOT, "temp");

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/outputs", express.static(OUTPUT_DIR));

/*
=========================================================
 MULTER
=========================================================
*/

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || ".mp4");
    const safeExt = ext && ext.length <= 10 ? ext : ".mp4";

    const filename =
      Date.now() +
      "-" +
      crypto.randomBytes(6).toString("hex") +
      safeExt;

    cb(null, filename);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 700 * 1024 * 1024
  },

  fileFilter: function (req, file, cb) {
    const allowed = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska",
      "video/avi",
      "video/mpeg"
    ];

    if (
      allowed.includes(file.mimetype) ||
      file.originalname.toLowerCase().match(/\.(mp4|webm|mov|mkv|avi|mpeg|mpg)$/)
    ) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported video format"));
    }
  }
});

/*
=========================================================
 GEMINI
=========================================================
*/

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    })
  : null;

const PRIMARY_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash"
].filter((v, i, a) => v && a.indexOf(v) === i);

/*
=========================================================
 JOB STORAGE
=========================================================
*/

const jobs = new Map();

/*
=========================================================
 UTILS
=========================================================
*/

function makeId() {
  return (
    crypto.randomBytes(6).toString("base64url") +
    "-" +
    Date.now().toString(36)
  );
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (e) {
    console.log("[CLEANUP] Could not delete:", file);
  }
}

function updateJob(id, data) {
  const job = jobs.get(id);

  if (!job) return;

  Object.assign(job, data);

  job.updatedAt = new Date().toISOString();
}

function setProgress(id, progress, stage, message, extra = {}) {
  const job = jobs.get(id);

  if (!job) return;

  job.progress = Math.max(
    0,
    Math.min(100, Math.round(progress))
  );

  if (stage !== undefined) {
    job.stage = stage;
  }

  if (message !== undefined) {
    job.message = message;
  }

  Object.assign(job, extra);

  job.updatedAt = new Date().toISOString();
}

function isRetryableGeminiError(error) {
  const text = JSON.stringify(error || {}).toLowerCase();

  return (
    text.includes("503") ||
    text.includes("unavailable") ||
    text.includes("high demand") ||
    text.includes("overloaded") ||
    text.includes("temporarily unavailable") ||
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("resource exhausted")
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/*
=========================================================
 PROMISE TIMEOUT
=========================================================
*/

async function withTimeout(promise, ms, label) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${Math.round(ms / 1000)} seconds`
        )
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/*
=========================================================
 GEMINI GENERATE WITH RETRY
=========================================================
*/

async function geminiGenerateWithRetry(
  id,
  options = {}
) {
  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY is not configured on Render"
    );
  }

  const {
    contents,
    progressStart = 35,
    progressEnd = 45,
    stage = "ANALYZE",
    label = "Gemini AI",
    timeoutMs = 180000
  } = options;

  let lastError = null;

  for (let modelIndex = 0; modelIndex < FALLBACK_MODELS.length; modelIndex++) {
    const model = FALLBACK_MODELS[modelIndex];

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(
          `[Gemini] ${label} model=${model} attempt=${attempt}/3`
        );

        const attemptBase =
          progressStart +
          ((progressEnd - progressStart) * modelIndex) /
            Math.max(1, FALLBACK_MODELS.length);

        setProgress(
          id,
          Math.min(progressEnd - 1, attemptBase),
          stage,
          `${label}: ${model} — attempt ${attempt}/3`,
          {
            modelUsed: model,
            attempt
          }
        );

        /*
        ---------------------------------------------------
        HEARTBEAT
        ---------------------------------------------------
        */

        let heartbeat = 0;

        const heartbeatTimer = setInterval(() => {
          heartbeat++;

          const span = Math.max(
            1,
            progressEnd - progressStart - 1
          );

          const current =
            progressStart +
            Math.min(
              span,
              heartbeat % (span + 1)
            );

          setProgress(
            id,
            current,
            stage,
            `${label}: processing...`,
            {
              modelUsed: model,
              attempt
            }
          );
        }, 5000);

        try {
          const response = await withTimeout(
            ai.models.generateContent({
              model,
              contents
            }),
            timeoutMs,
            `${label} (${model})`
          );

          clearInterval(heartbeatTimer);

          console.log(
            `[Gemini] SUCCESS model=${model}`
          );

          setProgress(
            id,
            progressEnd,
            stage,
            `${label}: completed`,
            {
              modelUsed: model,
              attempt,
              geminiSuccess: true
            }
          );

          return response;
        } catch (err) {
          clearInterval(heartbeatTimer);
          throw err;
        }
      } catch (error) {
        lastError = error;

        console.log(
          `[Gemini] FAILED model=${model} attempt=${attempt}`
        );

        console.log(
          JSON.stringify(
            error?.message ||
              error?.response ||
              error
          )
        );

        const retryable =
          isRetryableGeminiError(error);

        if (!retryable) {
          throw error;
        }

        if (attempt < 3) {
          const wait =
            attempt === 1
              ? 5000
              : attempt === 2
              ? 10000
              : 20000;

          setProgress(
            id,
            Math.min(
              progressEnd - 1,
              progressStart + attempt * 2
            ),
            stage,
            `Gemini busy — retrying in ${Math.round(
              wait / 1000
            )} seconds`,
            {
              modelUsed: model,
              attempt,
              retrying: true
            }
          );

          console.log(
            `[Gemini] Waiting ${wait}ms`
          );

          await sleep(wait);
        }
      }
    }

    /*
    -----------------------------------------------------
    SWITCH MODEL
    -----------------------------------------------------
    */

    if (modelIndex < FALLBACK_MODELS.length - 1) {
      setProgress(
        id,
        Math.min(
          progressEnd - 1,
          progressStart + 3
        ),
        stage,
        `Switching Gemini model...`,
        {
          retrying: true
        }
      );

      console.log(
        `[Gemini] Switching from ${model} to ${
          FALLBACK_MODELS[modelIndex + 1]
        }`
      );

      await sleep(1500);
    }
  }

  throw lastError || new Error("Gemini request failed");
}

/*
=========================================================
 GEMINI FILE UPLOAD
=========================================================
*/

async function uploadVideoToGemini(
  id,
  videoPath,
  mimeType
) {
  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY is not configured"
    );
  }

  console.log(
    `[Gemini] Uploading video: ${videoPath}`
  );

  setProgress(
    id,
    15,
    "UPLOAD",
    "Uploading video to Gemini..."
  );

  const uploaded = await ai.files.upload({
    file: videoPath,
    config: {
      mimeType:
        mimeType || "video/mp4"
    }
  });

  if (!uploaded || !uploaded.name) {
    throw new Error(
      "Gemini video upload returned no file name"
    );
  }

  setProgress(
    id,
    25,
    "UPLOAD",
    "Video uploaded. Gemini is processing the video..."
  );

  let file = uploaded;

  const maxPolls = 180;

  for (let i = 0; i < maxPolls; i++) {
    await sleep(3000);

    file = await ai.files.get({
      name: uploaded.name
    });

    const state =
      file?.state ||
      file?.status ||
      "UNKNOWN";

    console.log(
      `[Gemini] File state: ${state}`
    );

    if (
      String(state).toUpperCase() ===
        "ACTIVE" ||
      String(state).toUpperCase() ===
        "ACTIVE_STATE"
    ) {
      setProgress(
        id,
        35,
        "ANALYZE",
        "Video ready. Starting AI analysis..."
      );

      return file;
    }

    if (
      String(state).toUpperCase() ===
        "FAILED"
    ) {
      throw new Error(
        "Gemini video processing failed"
      );
    }

    const processingProgress =
      25 +
      Math.min(
        9,
        Math.floor(
          (i / maxPolls) * 10
        )
      );

    setProgress(
      id,
      processingProgress,
      "UPLOAD",
      `Gemini video processing... ${
        i + 1
      }/${maxPolls}`
    );
  }

  throw new Error(
    "Gemini video processing timeout"
  );
}

/*
=========================================================
 RESPONSE TEXT
=========================================================
*/

function getResponseText(response) {
  if (!response) return "";

  if (typeof response.text === "string") {
    return response.text.trim();
  }

  if (typeof response.text === "function") {
    try {
      const value = response.text();
      if (typeof value === "string") {
        return value.trim();
      }
    } catch (e) {}
  }

  try {
    const candidates =
      response.candidates || [];

    const parts =
      candidates[0]?.content?.parts || [];

    return parts
      .map(p => p?.text || "")
      .join("\n")
      .trim();
  } catch (e) {
    return "";
  }
}

/*
=========================================================
 VIDEO ANALYSIS
=========================================================
*/

async function analyzeVideoWithGemini(
  id,
  file
) {
  const prompt = `
You are a professional movie recap video analyst.

Analyze the uploaded video carefully.

Your job is to understand what ACTUALLY happens in the video.

Return a structured factual analysis including:

1. Main story
2. Important characters
3. Character relationships
4. Locations
5. Major events in chronological order
6. Important visual actions
7. Important turning points
8. Ending information visible in the uploaded video
9. Important objects or clues
10. Approximate scene sequence

IMPORTANT RULES:

- Only describe events actually visible or strongly supported by the video
- Do not invent scenes
- Do not invent character names
- Do not invent dialogue
- Do not reproduce long movie dialogue
- Do not reproduce screenplay text
- Do not claim events that are outside the uploaded video
- Focus on factual scene understanding
- The output will be used to create an original Myanmar-language commentary recap
`;

  const response =
    await geminiGenerateWithRetry(
      id,
      {
        contents: [
          {
            fileData: {
              mimeType:
                file.mimeType ||
                "video/mp4",
              fileUri: file.uri
            }
          },
          {
            text: prompt
          }
        ],

        progressStart: 36,
        progressEnd: 45,
        stage: "ANALYZE",
        label: "Video analysis",
        timeoutMs: 180000
      }
    );

  const analysis =
    getResponseText(response);

  if (!analysis) {
    throw new Error(
      "Gemini returned empty video analysis"
    );
  }

  return analysis;
}

/*
=========================================================
 MYANMAR RECAP SCRIPT
=========================================================
*/

async function generateMyanmarScript(
  id,
  analysis
) {
  const prompt = `
You are a professional Myanmar movie recap narrator.

Using the factual video analysis below, write an ORIGINAL Myanmar-language movie recap narration.

STYLE:

- Natural spoken Myanmar
- Easy to understand
- Storytelling style
- Engaging but factual
- Suitable for YouTube narration
- Explain events in chronological order
- Connect scenes naturally
- Use conversational Myanmar
- Do not use character-name prefixes
- Do not write dialogue as if you are the character
- Do not copy movie dialogue
- Do not reproduce screenplay
- Do not invent events
- Do not invent facts that are not supported by the analysis
- Do not add fake scenes
- Do not add unsupported ending details

IMPORTANT:

This is commentary/narration, not a screenplay.

Write only the narration.

VIDEO ANALYSIS:
${analysis}
`;

  const response =
    await geminiGenerateWithRetry(
      id,
      {
        contents: [
          {
            text: prompt
          }
        ],

        progressStart: 46,
        progressEnd: 55,
        stage: "SCRIPT",
        label: "Myanmar script",
        timeoutMs: 180000
      }
    );

  const script =
    getResponseText(response);

  if (!script) {
    throw new Error(
      "Gemini returned empty Myanmar script"
    );
  }

  return script;
}

/*
=========================================================
 TEXT CLEANING
=========================================================
*/

function cleanScript(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/^```[\s\S]*?```$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/*
=========================================================
 TTS
=========================================================
*/

function splitForTTS(text, maxLength = 180) {
  const normalized = String(text || "")
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const chunks = [];

  let current = "";

  const sentences = normalized.split(
    /(?<=[။!?၊])/u
  );

  for (const sentence of sentences) {
    const s = sentence.trim();

    if (!s) continue;

    if (
      (current + " " + s).trim().length <=
      maxLength
    ) {
      current =
        (current + " " + s).trim();
    } else {
      if (current) {
        chunks.push(current);
      }

      if (s.length <= maxLength) {
        current = s;
      } else {
        for (
          let i = 0;
          i < s.length;
          i += maxLength
        ) {
          chunks.push(
            s.slice(
              i,
              i + maxLength
            )
          );
        }

        current = "";
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function createMyanmarVoice(
  id,
  script
) {
  const chunks =
    splitForTTS(script, 180);

  if (!chunks.length) {
    throw new Error(
      "No text available for TTS"
    );
  }

  const jobTemp =
    path.join(
      TEMP_DIR,
      makeId()
    );

  fs.mkdirSync(jobTemp, {
    recursive: true
  });

  const audioFiles = [];

  console.log(
    `[TTS] Total chunks: ${chunks.length}`
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    console.log(
      `[TTS] ${i + 1}/${chunks.length}`
    );

    setProgress(
      id,
      55 +
        Math.floor(
          ((i + 1) /
            chunks.length) *
            18
        ),
      "VOICE",
      `Myanmar voice ${i + 1}/${chunks.length}`
    );

    const audioBase64 =
      await googleTTS.getAllAudioBase64(
        chunk,
        {
          lang: "my",
          slow: false,
          host: "https://translate.google.com"
        }
      );

    if (
      !audioBase64 ||
      !Array.isArray(audioBase64)
    ) {
      throw new Error(
        "Myanmar TTS returned invalid audio"
      );
    }

    for (
      let j = 0;
      j < audioBase64.length;
      j++
    ) {
      const item =
        audioBase64[j];

      const filename =
        `tts-${i}-${j}.mp3`;

      const audioPath =
        path.join(
          jobTemp,
          filename
        );

      const base64 =
        typeof item === "string"
          ? item
          : item.base64;

      if (!base64) {
        continue;
      }

      fs.writeFileSync(
        audioPath,
        Buffer.from(
          base64,
          "base64"
        )
      );

      audioFiles.push(
        audioPath
      );
    }
  }

  if (!audioFiles.length) {
    throw new Error(
      "No TTS audio files were created"
    );
  }

  const concatFile =
    path.join(
      jobTemp,
      "audio-list.txt"
    );

  const concatContent =
    audioFiles
      .map(file => {
        const safe =
          file
            .replace(/\\/g, "/")
            .replace(/'/g, "'\\''");

        return `file '${safe}'`;
      })
      .join("\n");

  fs.writeFileSync(
    concatFile,
    concatContent,
    "utf8"
  );

  const finalAudio =
    path.join(
      jobTemp,
      "narration.mp3"
    );

  setProgress(
    id,
    74,
    "VOICE",
    "Combining Myanmar narration..."
  );

  await runFFmpeg(
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFile,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      finalAudio
    ],
    {
      timeoutMs: 5 * 60 * 1000,
      label: "TTS audio merge"
    }
  );

  return {
    audioPath: finalAudio,
    tempDir: jobTemp,
    chunks
  };
}

/*
=========================================================
 SRT
=========================================================
*/

function formatSrtTime(seconds) {
  const totalMs =
    Math.max(
      0,
      Math.round(seconds * 1000)
    );

  const ms =
    totalMs % 1000;

  const totalSeconds =
    Math.floor(totalMs / 1000);

  const sec =
    totalSeconds % 60;

  const totalMinutes =
    Math.floor(totalSeconds / 60);

  const min =
    totalMinutes % 60;

  const hours =
    Math.floor(totalMinutes / 60);

  const pad = n =>
    String(n).padStart(2, "0");

  return `${pad(hours)}:${pad(min)}:${pad(sec)},${String(
    ms
  ).padStart(3, "0")}`;
}

function createSRT(chunks) {
  let output = "";

  let currentTime = 0;

  const averageSecondsPerCharacter =
    0.065;

  chunks.forEach((chunk, index) => {
    const duration =
      Math.max(
        2,
        chunk.length *
          averageSecondsPerCharacter
      );

    const start =
      currentTime;

    const end =
      currentTime + duration;

    output +=
      `${index + 1}\n` +
      `${formatSrtTime(start)} --> ${formatSrtTime(end)}\n` +
      `${chunk.trim()}\n\n`;

    currentTime = end;
  });

  return output;
}

/*
=========================================================
 FFPROBE
=========================================================
*/

function getVideoDuration(videoPath) {
  return new Promise(
    (resolve, reject) => {
      const args = [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath
      ];

      const proc =
        spawn(
          ffprobeStatic.path,
          args
        );

      let output = "";
      let error = "";

      proc.stdout.on(
        "data",
        data => {
          output += data.toString();
        }
      );

      proc.stderr.on(
        "data",
        data => {
          error += data.toString();
        }
      );

      proc.on(
        "error",
        reject
      );

      proc.on(
        "close",
        code => {
          if (code !== 0) {
            reject(
              new Error(
                `ffprobe failed: ${error}`
              )
            );
            return;
          }

          const duration =
            Number(
              output.trim()
            );

          if (
            !Number.isFinite(
              duration
            )
          ) {
            reject(
              new Error(
                "Could not determine video duration"
              )
            );
            return;
          }

          resolve(duration);
        }
      );
    }
  );
}

/*
=========================================================
 FFMPEG RUNNER
=========================================================
*/

function runFFmpeg(
  args,
  options = {}
) {
  const {
    timeoutMs = 20 * 60 * 1000,
    label = "FFmpeg",
    onProgress
  } = options;

  return new Promise(
    (resolve, reject) => {
      console.log(
        `[FFMPEG] Starting: ${label}`
      );

      const proc =
        spawn(
          ffmpegPath,
          args,
          {
            windowsHide: true
          }
        );

      let stderr = "";
      let stdout = "";

      let finished = false;

      const timer =
        setTimeout(() => {
          if (finished) return;

          console.log(
            `[FFMPEG] TIMEOUT: ${label}`
          );

          try {
            proc.kill("SIGKILL");
          } catch (e) {}

          reject(
            new Error(
              `${label} timed out`
            )
          );
        }, timeoutMs);

      proc.stdout.on(
        "data",
        data => {
          const text =
            data.toString();

          stdout += text;

          const lines =
            text
              .split(/\r?\n/)
              .filter(Boolean);

          for (const line of lines) {
            if (
              line.startsWith(
                "out_time_ms="
              )
            ) {
              const value =
                Number(
                  line.split("=")[1]
                );

              if (
                Number.isFinite(value) &&
                onProgress
              ) {
                onProgress(
                  value / 1000000
                );
              }
            }
          }
        }
      );

      proc.stderr.on(
        "data",
        data => {
          const text =
            data.toString();

          stderr += text;

          if (
            stderr.length >
            20000
          ) {
            stderr =
              stderr.slice(
                -20000
              );
          }

          const match =
            text.match(
              /time=(\d+):(\d+):(\d+(?:\.\d+)?)/ 
            );

          if (
            match &&
            onProgress
          ) {
            const seconds =
              Number(match[1]) * 3600 +
              Number(match[2]) * 60 +
              Number(match[3]);

            onProgress(seconds);
          }
        }
      );

      proc.on(
        "error",
        error => {
          if (finished) return;

          finished = true;

          clearTimeout(timer);

          reject(error);
        }
      );

      proc.on(
        "close",
        code => {
          if (finished) return;

          finished = true;

          clearTimeout(timer);

          if (code === 0) {
            console.log(
              `[FFMPEG] SUCCESS: ${label}`
            );

            resolve({
              stdout,
              stderr
            });

            return;
          }

          console.log(
            `[FFMPEG] FAILED: ${label} code=${code}`
          );

          reject(
            new Error(
              `FFmpeg failed (${label})\n${stderr.slice(
                -8000
              )}`
            )
          );
        }
      );
    }
  );
}

/*
=========================================================
 FINAL VIDEO RENDER
=========================================================
*/

async function renderFinalVideo(
  id,
  inputVideo,
  narrationAudio,
  srtPath
) {
  console.log(
    `[FFMPEG] Starting render for ${id}`
  );

  const duration =
    await getVideoDuration(
      inputVideo
    );

  console.log(
    `[FFMPEG] Video duration: ${duration}s`
  );

  const outputPath =
    path.join(
      OUTPUT_DIR,
      `${id}-recap.mp4`
    );

  /*
  -------------------------------------------------------
  ASS SUBTITLE FILE
  -------------------------------------------------------
  */

  const subtitlePath =
    srtPath;

  setProgress(
    id,
    75,
    "RENDER",
    "Starting FFmpeg video render..."
  );

  let lastProgress = 75;

  const renderArgs = [
    "-y",

    "-i",
    inputVideo,

    "-i",
    narrationAudio,

    "-map",
    "0:v:0",

    "-map",
    "1:a:0",

    "-vf",
    `subtitles=${subtitlePath.replace(
      /\\/g,
      "/"
    ).replace(
      /:/g,
      "\\:"
    )}`,

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-pix_fmt",
    "yuv420p",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-shortest",

    "-movflags",
    "+faststart",

    "-progress",
    "pipe:1",

    "-nostats",

    outputPath
  ];

  try {
    await runFFmpeg(
      renderArgs,
      {
        timeoutMs:
          20 * 60 * 1000,

        label:
          "Final MP4 with subtitles",

        onProgress: seconds => {
          if (
            !Number.isFinite(
              seconds
            )
          ) {
            return;
          }

          if (
            duration <= 0
          ) {
            return;
          }

          const ratio =
            Math.max(
              0,
              Math.min(
                1,
                seconds /
                  duration
              )
            );

          const progress =
            75 +
            Math.floor(
              ratio * 23
            );

          if (
            progress >
            lastProgress
          ) {
            lastProgress =
              progress;

            setProgress(
              id,
              Math.min(
                98,
                progress
              ),
              "RENDER",
              `Rendering final video... ${Math.min(
                100,
                Math.round(
                  ratio * 100
                )
              )}%`
            );
          }
        }
      }
    );

    if (
      !fs.existsSync(
        outputPath
      )
    ) {
      throw new Error(
        "FFmpeg completed but output MP4 was not found"
      );
    }

    return outputPath;
  } catch (error) {
    console.log(
      "[FFMPEG] Subtitle render failed"
    );

    console.log(
      error.message
    );

    /*
    -----------------------------------------------------
    FALLBACK WITHOUT BURNED SUBTITLE
    -----------------------------------------------------
    */

    setProgress(
      id,
      80,
      "RENDER",
      "Subtitle render failed. Creating clean MP4..."
    );

    const fallbackPath =
      path.join(
        OUTPUT_DIR,
        `${id}-recap-clean.mp4`
      );

    const fallbackArgs = [
      "-y",

      "-i",
      inputVideo,

      "-i",
      narrationAudio,

      "-map",
      "0:v:0",

      "-map",
      "1:a:0",

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "23",

      "-pix_fmt",
      "yuv420p",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-shortest",

      "-movflags",
      "+faststart",

      "-progress",
      "pipe:1",

      "-nostats",

      fallbackPath
    ];

    await runFFmpeg(
      fallbackArgs,
      {
        timeoutMs:
          20 * 60 * 1000,

        label:
          "Fallback clean MP4",

        onProgress: seconds => {
          if (
            !Number.isFinite(
              seconds
            )
          ) {
            return;
          }

          if (
            duration <= 0
          ) {
            return;
          }

          const ratio =
            Math.max(
              0,
              Math.min(
                1,
                seconds /
                  duration
              )
            );

          const progress =
            80 +
            Math.floor(
              ratio * 17
            );

          setProgress(
            id,
            Math.min(
              97,
              progress
            ),
            "RENDER",
            `Creating clean MP4... ${Math.round(
              ratio * 100
            )}%`
          );
        }
      }
    );

    if (
      !fs.existsSync(
        fallbackPath
      )
    ) {
      throw new Error(
        "Fallback MP4 was not created"
      );
    }

    return fallbackPath;
  }
}

/*
=========================================================
 JOB PROCESS
=========================================================
*/

async function processJob(
  id,
  videoPath,
  mimeType
) {
  const job =
    jobs.get(id);

  if (!job) {
    throw new Error(
      "Job not found"
    );
  }

  let geminiFile = null;
  let narration = null;

  try {
    /*
    -----------------------------------------------------
    STEP 1
    -----------------------------------------------------
    */

    setProgress(
      id,
      5,
      "START",
      "Preparing video..."
    );

    /*
    -----------------------------------------------------
    STEP 2
    -----------------------------------------------------
    */

    geminiFile =
      await uploadVideoToGemini(
        id,
        videoPath,
        mimeType
      );

    /*
    -----------------------------------------------------
    STEP 3
    -----------------------------------------------------
    */

    const analysis =
      await analyzeVideoWithGemini(
        id,
        geminiFile
      );

    updateJob(id, {
      analysis
    });

    /*
    -----------------------------------------------------
    STEP 4
    -----------------------------------------------------
    */

    const script =
      cleanScript(
        await generateMyanmarScript(
          id,
          analysis
        )
      );

    updateJob(id, {
      script
    });

    setProgress(
      id,
      55,
      "VOICE",
      "Myanmar narration script ready..."
    );

    /*
    -----------------------------------------------------
    STEP 5
    -----------------------------------------------------
    */

    narration =
      await createMyanmarVoice(
        id,
        script
      );

    /*
    -----------------------------------------------------
    STEP 6
    -----------------------------------------------------
    */

    setProgress(
      id,
      74,
      "SUBTITLE",
      "Creating subtitles..."
    );

    const srtContent =
      createSRT(
        narration.chunks
      );

    const srtPath =
      path.join(
        OUTPUT_DIR,
        `${id}.srt`
      );

    fs.writeFileSync(
      srtPath,
      srtContent,
      "utf8"
    );

    /*
    -----------------------------------------------------
    STEP 7
    -----------------------------------------------------
    */

    const finalVideo =
      await renderFinalVideo(
        id,
        videoPath,
        narration.audioPath,
        srtPath
      );

    /*
    -----------------------------------------------------
    FINAL
    -----------------------------------------------------
    */

    const videoUrl =
      `/outputs/${path.basename(
        finalVideo
      )}`;

    const subtitleUrl =
      `/outputs/${path.basename(
        srtPath
      )}`;

    setProgress(
      id,
      100,
      "DONE",
      "RECAP VIDEO READY",
      {
        status: "completed",
        videoUrl,
        subtitleUrl,
        completedAt:
          new Date().toISOString()
      }
    );

    console.log(
      `================================================`
    );

    console.log(
      `[JOB COMPLETE] ${id}`
    );

    console.log(
      `Video: ${videoUrl}`
    );

    console.log(
      `Subtitle: ${subtitleUrl}`
    );

    console.log(
      `================================================`
    );
  } catch (error) {
    console.error(
      "JOB FAILED:",
      error
    );

    updateJob(id, {
      status: "failed",
      error:
        error?.message ||
        String(error),
      failedAt:
        new Date().toISOString()
    });

    setProgress(
      id,
      job.progress || 0,
      "ERROR",
      error?.message ||
        "Job failed"
    );
  }
}

/*
=========================================================
 HEALTH
=========================================================
*/

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      app:
        "RECAP ONE CLIP",

      version:
        "3.1.0",

      gemini:
        Boolean(GEMINI_API_KEY),

      model:
        PRIMARY_MODEL,

      fallbackModels:
        FALLBACK_MODELS,

      ffmpeg:
        Boolean(ffmpegPath),

      ffprobe:
        Boolean(
          ffprobeStatic?.path
        ),

      time:
        new Date().toISOString()
    });
  }
);

/*
=========================================================
 ROOT
=========================================================
*/

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      app:
        "RECAP ONE CLIP",
      version:
        "3.1.0",
      message:
        "Myanmar AI Recap Studio is running"
    });
  }
);

/*
=========================================================
 UPLOAD
=========================================================
*/

app.post(
  "/api/upload",
  upload.single("video"),
  (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              "No video uploaded"
          });
      }

      const id =
        makeId();

      jobs.set(id, {
        id,

        status:
          "uploaded",

        progress: 0,

        stage:
          "UPLOAD",

        message:
          "Video uploaded. Ready to analyze.",

        originalName:
          req.file.originalname,

        filePath:
          req.file.path,

        mimeType:
          req.file.mimetype,

        createdAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString()
      });

      console.log(
        `[UPLOAD] ${id} ${req.file.originalname}`
      );

      res.json({
        ok: true,

        id,

        jobId: id,

        filename:
          req.file.filename,

        originalName:
          req.file.originalname,

        size:
          req.file.size,

        message:
          "Video uploaded successfully"
      });
    } catch (error) {
      console.error(
        "[UPLOAD ERROR]",
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

/*
=========================================================
 GENERATE
=========================================================
*/

app.post(
  "/api/generate/:id",
  async (req, res) => {
    const id =
      req.params.id;

    const job =
      jobs.get(id);

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            "Job not found"
        });
    }

    if (
      job.status ===
        "processing"
    ) {
      return res.json({
        ok: true,
        id,
        status:
          "processing",
        message:
          "Job is already processing"
      });
    }

    if (
      job.status ===
      "completed"
    ) {
      return res.json({
        ok: true,
        id,
        status:
          "completed",
        videoUrl:
          job.videoUrl,
        subtitleUrl:
          job.subtitleUrl
      });
    }

    updateJob(id, {
      status:
        "processing",

      progress:
        1,

      stage:
        "START",

      message:
        "Starting recap generation..."
    });

    res.json({
      ok: true,

      id,

      status:
        "processing",

      message:
        "Recap generation started"
    });

    /*
    IMPORTANT:
    Do not await here.
    Let Render continue the job.
    */

    processJob(
      id,
      job.filePath,
      job.mimeType
    ).catch(error => {
      console.error(
        "[PROCESS ERROR]",
        error
      );
    });
  }
);

/*
=========================================================
 STATUS
=========================================================
*/

app.get(
  "/api/status/:id",
  (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            "Job not found"
        });
    }

    res.json({
      ok: true,

      id:
        job.id,

      status:
        job.status,

      progress:
        job.progress,

      stage:
        job.stage,

      message:
        job.message,

      originalName:
        job.originalName,

      modelUsed:
        job.modelUsed ||
        null,

      attempt:
        job.attempt ||
        null,

      videoUrl:
        job.videoUrl ||
        null,

      subtitleUrl:
        job.subtitleUrl ||
        null,

      error:
        job.error ||
        null,

      createdAt:
        job.createdAt,

      updatedAt:
        job.updatedAt,

      completedAt:
        job.completedAt ||
        null,

      failedAt:
        job.failedAt ||
        null
    });
  }
);

/*
=========================================================
 JOB LIST
=========================================================
*/

app.get(
  "/api/jobs",
  (req, res) => {
    const list =
      Array.from(
        jobs.values()
      )
        .sort(
          (a, b) =>
            new Date(b.createdAt) -
            new Date(a.createdAt)
        )
        .slice(0, 50)
        .map(job => ({
          id:
            job.id,

          status:
            job.status,

          progress:
            job.progress,

          stage:
            job.stage,

          message:
            job.message,

          originalName:
            job.originalName,

          videoUrl:
            job.videoUrl ||
            null,

          createdAt:
            job.createdAt
        }));

    res.json({
      ok: true,
      jobs: list
    });
  }
);

/*
=========================================================
 ERROR HANDLER
=========================================================
*/

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "[SERVER ERROR]",
      error
    );

    if (
      error instanceof
      multer.MulterError
    ) {
      return res
        .status(400)
        .json({
          error:
            error.message
        });
    }

    res
      .status(500)
      .json({
        error:
          error.message ||
          "Internal server error"
      });
  }
);

/*
=========================================================
 START
=========================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "======================================"
    );

    console.log(
      "      RECAP ONE CLIP V3.1"
    );

    console.log(
      "      Myanmar AI Recap Studio"
    );

    console.log(
      "======================================"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Gemini: ${
        GEMINI_API_KEY
          ? "CONFIGURED"
          : "NOT CONFIGURED"
      }`
    );

    console.log(
      `Primary Model: ${PRIMARY_MODEL}`
    );

    console.log(
      `Fallback Models: ${FALLBACK_MODELS.join(
        ", "
      )}`
    );

    console.log(
      `FFmpeg: ${
        ffmpegPath
          ? "READY"
          : "NOT FOUND"
      }`
    );

    console.log(
      `FFprobe: ${
        ffprobeStatic?.path
          ? "READY"
          : "NOT FOUND"
      }`
    );

    console.log(
      "======================================"
    );
  }
);

/*
=========================================================
 CLEAN OLD TEMP FILES
=========================================================
*/

setInterval(
  () => {
    try {
      const now =
        Date.now();

      const maxAge =
        6 * 60 * 60 * 1000;

      for (const dir of [
        UPLOAD_DIR,
        TEMP_DIR
      ]) {
        if (
          !fs.existsSync(
            dir
          )
        ) {
          continue;
        }

        for (
          const name of fs.readdirSync(
            dir
          )
        ) {
          const full =
            path.join(
              dir,
              name
            );

          try {
            const stat =
              fs.statSync(
                full
              );

            if (
              now -
                stat.mtimeMs >
              maxAge
            ) {
              safeUnlink(
                full
              );
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      console.log(
        "[CLEANUP] Error",
        e.message
      );
    }
  },
  60 * 60 * 1000
);
