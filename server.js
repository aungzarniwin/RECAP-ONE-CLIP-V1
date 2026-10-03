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
const ffprobePath = ffprobeStatic.path;

const googleTTS = require("google-tts-api");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const PORT = process.env.PORT || 10000;

const ROOT_DIR = __dirname;
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const OUTPUT_DIR = path.join(ROOT_DIR, "outputs");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/* =========================================================
   GEMINI
========================================================= */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const PRIMARY_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash"
].filter((v, i, a) => v && a.indexOf(v) === i);

let ai = null;

if (GEMINI_API_KEY) {
  ai = new GoogleGenAI({
    apiKey: GEMINI_API_KEY
  });
}

/* =========================================================
   APP
========================================================= */

app.use(
  cors({
    origin: true,
    credentials: false
  })
);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/outputs", express.static(OUTPUT_DIR));

/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || ".mp4";

    const safeName =
      Date.now() +
      "-" +
      crypto.randomBytes(5).toString("hex") +
      ext;

    cb(null, safeName);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 700 * 1024 * 1024
  }
});

/* =========================================================
   JOB STORAGE
========================================================= */

const jobs = new Map();

function createJob(file) {
  const id =
    Date.now().toString(36) +
    "-" +
    crypto.randomBytes(5).toString("hex");

  const job = {
    id,

    status: "uploaded",

    progress: 0,

    stage: "READY",

    message: "Video uploaded",

    file: file.path,

    originalName: file.originalname,

    mimeType: file.mimetype,

    notes: "",

    voiceStyle: "natural",

    script: "",

    analysis: "",

    narrationFile: null,

    subtitleFile: null,

    outputFile: null,

    outputUrl: null,

    subtitleUrl: null,

    modelUsed: null,

    attempts: 0,

    error: null,

    createdAt: Date.now(),

    updatedAt: Date.now()
  };

  jobs.set(id, job);

  return job;
}

function updateJob(id, data) {
  const job = jobs.get(id);

  if (!job) {
    return;
  }

  Object.assign(job, data);

  job.updatedAt = Date.now();

  jobs.set(id, job);
}

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (e) {
    console.log("Cleanup warning:", e.message);
  }
}

function cleanGeminiText(text) {
  if (!text) return "";

  let result = String(text);

  result = result.replace(/```[\s\S]*?```/g, "");

  result = result.replace(/^Analysis\s*:/i, "");

  result = result.trim();

  return result;
}

/* =========================================================
   ERROR HELPERS
========================================================= */

function isRetryableGeminiError(error) {
  const message =
    error?.message ||
    error?.toString() ||
    "";

  const code =
    error?.status ||
    error?.code ||
    "";

  return (
    String(code).includes("503") ||
    String(code).includes("UNAVAILABLE") ||
    message.includes("503") ||
    message.includes("UNAVAILABLE") ||
    message.toLowerCase().includes("high demand") ||
    message.toLowerCase().includes("overloaded") ||
    message.toLowerCase().includes("temporarily unavailable")
  );
}

/* =========================================================
   GEMINI GENERATION WITH RETRY + FALLBACK
========================================================= */

async function geminiGenerateWithRetry(jobId, contents, options = {}) {

  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY is not configured on Render"
    );
  }

  const maxAttemptsPerModel =
    options.maxAttemptsPerModel || 3;

  let lastError = null;

  for (const model of FALLBACK_MODELS) {

    for (
      let attempt = 1;
      attempt <= maxAttemptsPerModel;
      attempt++
    ) {

      try {

        updateJob(jobId, {
          stage: "ANALYZE",
          message:
            `Gemini ${model} processing... attempt ${attempt}/${maxAttemptsPerModel}`,
          modelUsed: model,
          attempts: attempt
        });

        console.log(
          `[Gemini] model=${model} attempt=${attempt}/${maxAttemptsPerModel}`
        );

        const response =
          await ai.models.generateContent({
            model,
            contents
          });

        const text =
          response?.text ||
          response?.response?.text ||
          "";

        if (!text || !String(text).trim()) {
          throw new Error(
            `Gemini ${model} returned an empty response`
          );
        }

        console.log(
          `[Gemini] SUCCESS model=${model}`
        );

        updateJob(jobId, {
          modelUsed: model,
          message:
            `Gemini analysis completed with ${model}`
        });

        return cleanGeminiText(text);

      } catch (error) {

        lastError = error;

        console.error(
          `[Gemini] FAILED model=${model} attempt=${attempt}`,
          error?.message || error
        );

        const retryable =
          isRetryableGeminiError(error);

        if (!retryable) {
          throw error;
        }

        if (attempt < maxAttemptsPerModel) {

          const wait =
            Math.min(
              5000 * Math.pow(2, attempt - 1),
              30000
            );

          updateJob(jobId, {
            stage: "ANALYZE",
            message:
              `Gemini server busy — retrying in ${Math.round(wait / 1000)}s`
          });

          console.log(
            `[Gemini] 503/unavailable. Waiting ${wait}ms`
          );

          await sleep(wait);
        }
      }
    }

    updateJob(jobId, {
      stage: "ANALYZE",
      message:
        `${model} unavailable — switching to another Gemini model`
    });

    console.log(
      `[Gemini] Switching away from ${model}`
    );
  }

  throw new Error(
    `Gemini temporarily unavailable after retrying multiple models. Last error: ${
      lastError?.message || "Unknown Gemini error"
    }`
  );
}

/* =========================================================
   VIDEO FILE UPLOAD TO GEMINI
========================================================= */

async function uploadVideoToGemini(jobId, filePath, mimeType) {

  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY is not configured"
    );
  }

  updateJob(jobId, {
    progress: 20,
    stage: "ANALYZE",
    message: "Uploading video to Gemini..."
  });

  console.log(
    `[Gemini] Uploading video: ${filePath}`
  );

  const uploaded =
    await ai.files.upload({
      file: filePath,

      config: {
        mimeType:
          mimeType || "video/mp4"
      }
    });

  if (!uploaded || !uploaded.name) {
    throw new Error(
      "Gemini video upload returned no file reference"
    );
  }

  updateJob(jobId, {
    progress: 30,
    stage: "ANALYZE",
    message: "Gemini is processing the video..."
  });

  let fileInfo = uploaded;

  const maxPolls = 180;

  for (let i = 0; i < maxPolls; i++) {

    if (
      fileInfo.state === "ACTIVE" ||
      fileInfo.state === "ACTIVE_STATE"
    ) {
      break;
    }

    if (fileInfo.state === "FAILED") {
      throw new Error(
        "Gemini video processing failed"
      );
    }

    await sleep(3000);

    fileInfo =
      await ai.files.get({
        name: uploaded.name
      });

    if (i % 5 === 0) {
      console.log(
        `[Gemini] File state: ${fileInfo.state}`
      );
    }
  }

  if (
    fileInfo.state !== "ACTIVE" &&
    fileInfo.state !== "ACTIVE_STATE"
  ) {
    throw new Error(
      `Gemini video processing timeout. State: ${fileInfo.state}`
    );
  }

  updateJob(jobId, {
    progress: 35,
    stage: "ANALYZE",
    message: "Video ready for Gemini analysis"
  });

  return fileInfo;
}

/* =========================================================
   VIDEO ANALYSIS
========================================================= */

async function analyzeVideo(jobId, fileInfo, notes) {

  const prompt = `
You are an expert movie recap writer.

Analyze the uploaded video carefully.

Create a detailed factual scene-by-scene understanding of the video.

Focus on:

1. Main characters
2. Character relationships
3. Setting
4. Important events
5. Major conflict
6. Cause and effect
7. Important turning points
8. Ending or current ending shown
9. Emotional changes
10. Important visual details
11. Approximate chronological order

The final information will be used to create a Myanmar-language recap narration.

Do NOT invent events that are not supported by the video.

Do NOT reproduce long original dialogue.

Do NOT copy the screenplay.

Give a concise but sufficiently detailed analysis.

User notes:
${notes || "No additional notes"}
`;

  const contents = [
    {
      role: "user",

      parts: [
        {
          fileData: {
            fileUri: fileInfo.uri,

            mimeType:
              fileInfo.mimeType ||
              "video/mp4"
          }
        },

        {
          text: prompt
        }
      ]
    }
  ];

  const result =
    await geminiGenerateWithRetry(
      jobId,
      contents,
      {
        maxAttemptsPerModel: 3
      }
    );

  return result;
}

/* =========================================================
   SCRIPT GENERATION
========================================================= */

async function generateMyanmarScript(
  jobId,
  analysis,
  notes
) {

  updateJob(jobId, {
    progress: 50,
    stage: "SCRIPT",
    message: "Writing Myanmar recap narration..."
  });

  const prompt = `
You are a professional Myanmar movie recap narrator.

Using the video analysis below, write a natural Myanmar-language recap narration.

Requirements:

- Myanmar language
- Natural spoken style
- Easy to understand
- Storytelling style
- Do not use screenplay formatting
- Do not use character-name prefixes
- Do not copy original dialogue
- Do not invent events
- Keep chronological flow
- Explain important actions and consequences
- Make it interesting for a YouTube recap audience
- Suitable for voice narration
- Avoid unnecessary English
- Avoid excessive repetition

The narration should sound like a human Myanmar narrator explaining the story.

User notes:
${notes || "None"}

VIDEO ANALYSIS:
${analysis}

Return ONLY the narration.
`;

  const contents = [
    {
      role: "user",

      parts: [
        {
          text: prompt
        }
      ]
    }
  ];

  const result =
    await geminiGenerateWithRetry(
      jobId,
      contents,
      {
        maxAttemptsPerModel: 3
      }
    );

  return result;
}

/* =========================================================
   TTS
========================================================= */

function splitText(text, maxLength = 180) {

  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) {
    return [];
  }

  const sentences =
    clean.split(/(?<=[။!?])/);

  const chunks = [];

  let current = "";

  for (const sentence of sentences) {

    const s = sentence.trim();

    if (!s) continue;

    if (
      (current + " " + s).trim().length
      <= maxLength
    ) {

      current =
        (current + " " + s).trim();

    } else {

      if (current) {
        chunks.push(current);
      }

      current = s;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function createMyanmarVoice(
  jobId,
  script
) {

  updateJob(jobId, {
    progress: 65,
    stage: "VOICE",
    message: "Generating Myanmar narration..."
  });

  const chunks =
    splitText(script, 180);

  if (!chunks.length) {
    throw new Error(
      "Narration script is empty"
    );
  }

  const audioParts = [];

  for (let i = 0; i < chunks.length; i++) {

    const text = chunks[i];

    console.log(
      `[TTS] ${i + 1}/${chunks.length}`
    );

    try {

      const base64List =
        await googleTTS.getAllAudioBase64(
          text,
          {
            lang: "my",
            slow: false,

            host:
              "https://translate.google.com"
          }
        );

      if (
        !Array.isArray(base64List) ||
        !base64List.length
      ) {
        throw new Error(
          "TTS returned empty audio"
        );
      }

      for (const item of base64List) {

        if (typeof item === "string") {

          audioParts.push(
            Buffer.from(item, "base64")
          );

        } else if (item?.base64) {

          audioParts.push(
            Buffer.from(
              item.base64,
              "base64"
            )
          );
        }
      }

    } catch (error) {

      console.error(
        `[TTS] Chunk ${i + 1} failed`,
        error.message
      );

      throw new Error(
        `Myanmar voice generation failed at chunk ${
          i + 1
        }: ${error.message}`
      );
    }

    const progress =
      65 +
      Math.round(
        ((i + 1) / chunks.length) * 12
      );

    updateJob(jobId, {
      progress,
      stage: "VOICE",
      message:
        `Myanmar narration ${i + 1}/${chunks.length}`
    });
  }

  const outputFile =
    path.join(
      OUTPUT_DIR,
      `${jobId}-narration.mp3`
    );

  fs.writeFileSync(
    outputFile,
    Buffer.concat(audioParts)
  );

  if (
    !fs.existsSync(outputFile) ||
    fs.statSync(outputFile).size === 0
  ) {
    throw new Error(
      "Narration MP3 was not created"
    );
  }

  updateJob(jobId, {
    progress: 78,
    stage: "VOICE",
    message: "Myanmar narration ready",
    narrationFile: outputFile
  });

  return outputFile;
}

/* =========================================================
   SRT
========================================================= */

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

  const s =
    totalSeconds % 60;

  const totalMinutes =
    Math.floor(totalSeconds / 60);

  const m =
    totalMinutes % 60;

  const h =
    Math.floor(totalMinutes / 60);

  const pad = (n, size) =>
    String(n).padStart(size, "0");

  return (
    `${pad(h, 2)}:` +
    `${pad(m, 2)}:` +
    `${pad(s, 2)},` +
    `${pad(ms, 3)}`
  );
}

function buildSrt(script) {

  const chunks =
    splitText(script, 90);

  let result = "";

  const secondsPerCharacter = 0.055;

  let currentTime = 0;

  chunks.forEach((text, index) => {

    const duration =
      Math.max(
        2.2,
        text.length *
          secondsPerCharacter
      );

    const start =
      currentTime;

    const end =
      currentTime + duration;

    result +=
      `${index + 1}\n` +
      `${formatSrtTime(start)} --> ${formatSrtTime(end)}\n` +
      `${text}\n\n`;

    currentTime = end;
  });

  return result;
}

function createSrtFile(jobId, script) {

  updateJob(jobId, {
    progress: 82,
    stage: "SUBTITLE",
    message: "Creating Myanmar subtitles..."
  });

  const srt =
    buildSrt(script);

  const outputFile =
    path.join(
      OUTPUT_DIR,
      `${jobId}-subtitle.srt`
    );

  fs.writeFileSync(
    outputFile,
    "\ufeff" + srt,
    "utf8"
  );

  updateJob(jobId, {
    progress: 86,
    stage: "SUBTITLE",
    message: "Subtitle ready",
    subtitleFile: outputFile
  });

  return outputFile;
}

/* =========================================================
   FFPROBE
========================================================= */

function getVideoDuration(file) {

  return new Promise((resolve, reject) => {

    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file
    ];

    const proc =
      spawn(
        ffprobePath,
        args
      );

    let output = "";
    let errorOutput = "";

    proc.stdout.on(
      "data",
      (data) => {
        output += data.toString();
      }
    );

    proc.stderr.on(
      "data",
      (data) => {
        errorOutput += data.toString();
      }
    );

    proc.on(
      "error",
      reject
    );

    proc.on(
      "close",
      (code) => {

        if (code !== 0) {
          reject(
            new Error(
              errorOutput ||
              "ffprobe failed"
            )
          );

          return;
        }

        const duration =
          parseFloat(
            output.trim()
          );

        if (!Number.isFinite(duration)) {
          reject(
            new Error(
              "Could not detect video duration"
            )
          );

          return;
        }

        resolve(duration);
      }
    );
  });
}

/* =========================================================
   FFMPEG RENDER
========================================================= */

function renderVideo(
  jobId,
  inputVideo,
  narrationFile,
  subtitleFile,
  outputFile
) {

  return new Promise(
    async (resolve, reject) => {

      let duration = 0;

      try {
        duration =
          await getVideoDuration(
            inputVideo
          );
      } catch (error) {

        console.log(
          "Duration detection warning:",
          error.message
        );
      }

      updateJob(jobId, {
        progress: 88,
        stage: "RENDER",
        message: "Rendering final MP4..."
      });

      console.log(
        `[FFMPEG] Starting render for ${jobId}`
      );

      const subtitleEscaped =
        subtitleFile
          .replace(/\\/g, "\\\\")
          .replace(/:/g, "\\:")
          .replace(/'/g, "\\'");

      const filter =
        `subtitles='${subtitleEscaped}':force_style='FontName=Noto Sans,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=35'`;

      const args = [
        "-y",

        "-i",
        inputVideo,

        "-i",
        narrationFile,

        "-map",
        "0:v:0",

        "-map",
        "1:a:0",

        "-vf",
        filter,

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

        outputFile
      ];

      const ffmpeg =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";
      let lastProgress = 88;

      ffmpeg.stderr.on(
        "data",
        (data) => {

          const text =
            data.toString();

          stderr += text;

          const match =
            text.match(
              /time=(\d+):(\d+):(\d+(?:\.\d+)?)/
            );

          if (
            match &&
            duration > 0
          ) {

            const h =
              Number(match[1]);

            const m =
              Number(match[2]);

            const s =
              Number(match[3]);

            const current =
              h * 3600 +
              m * 60 +
              s;

            const ratio =
              Math.min(
                1,
                current / duration
              );

            const progress =
              Math.min(
                99,
                88 +
                Math.round(
                  ratio * 11
                )
              );

            if (
              progress >
              lastProgress
            ) {

              lastProgress =
                progress;

              updateJob(jobId, {
                progress,
                stage: "RENDER",
                message:
                  `Rendering final MP4 ${progress}%`
              });
            }
          }
        }
      );

      ffmpeg.on(
        "error",
        (error) => {

          reject(
            new Error(
              `FFmpeg process error: ${error.message}`
            )
          );
        }
      );

      ffmpeg.on(
        "close",
        (code) => {

          if (code !== 0) {

            console.error(
              "[FFMPEG ERROR]",
              stderr.slice(-8000)
            );

            reject(
              new Error(
                `FFmpeg render failed with code ${code}`
              )
            );

            return;
          }

          if (
            !fs.existsSync(outputFile)
          ) {

            reject(
              new Error(
                "FFmpeg finished but MP4 file was not created"
              )
            );

            return;
          }

          const size =
            fs.statSync(
              outputFile
            ).size;

          if (size < 1000) {

            reject(
              new Error(
                "Generated MP4 is invalid or empty"
              )
            );

            return;
          }

          console.log(
            `[FFMPEG] Render complete ${outputFile} (${size} bytes)`
          );

          resolve();
        }
      );
    }
  );
}

/* =========================================================
   FALLBACK RENDER WITHOUT SUBTITLE BURN-IN
========================================================= */

function renderVideoWithoutSubtitle(
  jobId,
  inputVideo,
  narrationFile,
  outputFile
) {

  return new Promise(
    async (resolve, reject) => {

      updateJob(jobId, {
        progress: 90,
        stage: "RENDER",
        message:
          "Subtitle burn-in unavailable — rendering clean MP4..."
      });

      const args = [
        "-y",

        "-i",
        inputVideo,

        "-i",
        narrationFile,

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

        outputFile
      ];

      const ffmpeg =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";

      ffmpeg.stderr.on(
        "data",
        (data) => {
          stderr += data.toString();
        }
      );

      ffmpeg.on(
        "error",
        reject
      );

      ffmpeg.on(
        "close",
        (code) => {

          if (code !== 0) {

            console.error(
              "[FFMPEG FALLBACK ERROR]",
              stderr.slice(-5000)
            );

            reject(
              new Error(
                `Fallback FFmpeg failed with code ${code}`
              )
            );

            return;
          }

          if (
            !fs.existsSync(outputFile)
          ) {

            reject(
              new Error(
                "Fallback MP4 was not created"
              )
            );

            return;
          }

          resolve();
        }
      );
    }
  );
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({
      ok: true,

      app: "RECAP ONE CLIP",

      version: "3.0.0",

      gemini:
        Boolean(GEMINI_API_KEY),

      model:
        PRIMARY_MODEL,

      fallbackModels:
        FALLBACK_MODELS,

      ffmpeg:
        Boolean(ffmpegPath),

      ffprobe:
        Boolean(ffprobePath),

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {

    const indexFile =
      path.join(
        ROOT_DIR,
        "index.html"
      );

    if (
      fs.existsSync(indexFile)
    ) {

      res.sendFile(
        indexFile
      );

      return;
    }

    res.json({
      app: "RECAP ONE CLIP",
      version: "3.0.0",
      status: "running"
    });
  }
);

/* =========================================================
   UPLOAD
========================================================= */

app.post(
  "/api/upload",
  upload.single("video"),
  async (req, res) => {

    try {

      if (!req.file) {

        return res.status(400).json({
          error:
            "No video file uploaded"
        });
      }

      const job =
        createJob(
          req.file
        );

      res.json({
        ok: true,

        jobId:
          job.id,

        status:
          job.status,

        progress:
          job.progress,

        fileName:
          job.originalName
      });

    } catch (error) {

      console.error(
        "Upload error:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   GENERATE
========================================================= */

app.post(
  "/api/generate/:id",
  async (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {

      return res.status(404).json({
        error:
          "Job not found"
      });
    }

    if (
      job.status === "processing"
    ) {

      return res.json({
        ok: true,
        message:
          "Job is already processing",
        jobId:
          job.id
      });
    }

    job.status =
      "processing";

    job.notes =
      req.body?.notes || "";

    job.voiceStyle =
      req.body?.voiceStyle ||
      "natural";

    updateJob(
      job.id,
      {
        status: "processing",
        progress: 5,
        stage: "ANALYZE",
        message:
          "Starting AI video analysis..."
      }
    );

    res.json({
      ok: true,

      jobId:
        job.id,

      status:
        "processing"
    });

    processJob(job.id)
      .catch(
        (error) => {

          console.error(
            `[JOB ${job.id}] FAILED`,
            error
          );

          updateJob(
            job.id,
            {
              status: "error",

              progress:
                Math.min(
                  99,
                  job.progress || 0
                ),

              stage:
                "ERROR",

              message:
                error.message,

              error:
                error.message
            }
          );
        }
      );
  }
);

/* =========================================================
   PROCESS JOB
========================================================= */

async function processJob(
  jobId
) {

  const job =
    jobs.get(jobId);

  if (!job) {
    throw new Error(
      "Job not found"
    );
  }

  let geminiFile = null;

  try {

    /* -----------------------------------------
       1. CHECK VIDEO
    ----------------------------------------- */

    updateJob(jobId, {
      progress: 8,
      stage: "ANALYZE",
      message:
        "Checking uploaded video..."
    });

    if (
      !fs.existsSync(
        job.file
      )
    ) {

      throw new Error(
        "Uploaded video file no longer exists"
      );
    }

    /* -----------------------------------------
       2. UPLOAD TO GEMINI
    ----------------------------------------- */

    geminiFile =
      await uploadVideoToGemini(
        jobId,
        job.file,
        job.mimeType
      );

    /* -----------------------------------------
       3. ANALYZE
    ----------------------------------------- */

    const analysis =
      await analyzeVideo(
        jobId,
        geminiFile,
        job.notes
      );

    updateJob(jobId, {
      analysis,
      progress: 45,
      stage: "SCRIPT",
      message:
        "Video analysis completed"
    });

    /* -----------------------------------------
       4. SCRIPT
    ----------------------------------------- */

    const script =
      await generateMyanmarScript(
        jobId,
        analysis,
        job.notes
      );

    updateJob(jobId, {
      script,
      progress: 60,
      stage: "VOICE",
      message:
        "Myanmar recap script completed"
    });

    /* -----------------------------------------
       5. VOICE
    ----------------------------------------- */

    const narrationFile =
      await createMyanmarVoice(
        jobId,
        script
      );

    /* -----------------------------------------
       6. SUBTITLE
    ----------------------------------------- */

    const subtitleFile =
      createSrtFile(
        jobId,
        script
      );

    /* -----------------------------------------
       7. RENDER
    ----------------------------------------- */

    const outputFile =
      path.join(
        OUTPUT_DIR,
        `${jobId}-recap.mp4`
      );

    updateJob(jobId, {
      progress: 88,
      stage: "RENDER",
      message:
        "Starting final MP4 render..."
    });

    try {

      await renderVideo(
        jobId,
        job.file,
        narrationFile,
        subtitleFile,
        outputFile
      );

    } catch (renderError) {

      console.error(
        `[JOB ${jobId}] Subtitle render failed:`,
        renderError.message
      );

      /*
        Subtitle burn-in failed.
        Do not lose the entire job.
        Render a clean MP4 instead.
      */

      await renderVideoWithoutSubtitle(
        jobId,
        job.file,
        narrationFile,
        outputFile
      );
    }

    /* -----------------------------------------
       8. COMPLETE
    ----------------------------------------- */

    updateJob(jobId, {

      status:
        "completed",

      progress:
        100,

      stage:
        "READY",

      message:
        "RECAP VIDEO READY",

      outputFile,

      outputUrl:
        `/outputs/${path.basename(outputFile)}`,

      subtitleUrl:
        `/outputs/${path.basename(subtitleFile)}`,

      subtitleFile,

      narrationFile,

      error:
        null
    });

    console.log(
      `[JOB ${jobId}] COMPLETED`
    );

  } catch (error) {

    console.error(
      `[JOB ${jobId}] PROCESS ERROR`,
      error
    );

    throw error;
  }
}

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status/:id",
  (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {

      return res.status(404).json({
        error:
          "Job not found"
      });
    }

    res.json({
      ok: true,

      jobId:
        job.id,

      status:
        job.status,

      progress:
        job.progress,

      stage:
        job.stage,

      message:
        job.message,

      outputUrl:
        job.outputUrl
          ? `/outputs/${path.basename(job.outputFile)}`
          : null,

      subtitleUrl:
        job.subtitleFile
          ? `/outputs/${path.basename(job.subtitleFile)}`
          : null,

      modelUsed:
        job.modelUsed,

      attempts:
        job.attempts,

      error:
        job.error
    });
  }
);

/* =========================================================
   404 API
========================================================= */

app.use(
  "/api",
  (req, res) => {

    res.status(404).json({
      error:
        "API endpoint not found"
    });
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {

    console.error(
      "GLOBAL ERROR:",
      err
    );

    if (
      err instanceof multer.MulterError
    ) {

      return res.status(400).json({
        error:
          `Upload error: ${err.message}`
      });
    }

    res.status(500).json({
      error:
        err.message ||
        "Internal server error"
    });
  }
);

/* =========================================================
   CLEAN OLD JOBS
========================================================= */

setInterval(
  () => {

    const now =
      Date.now();

    for (
      const [id, job]
      of jobs.entries()
    ) {

      if (
        now - job.updatedAt >
        60 * 60 * 1000
      ) {

        jobs.delete(id);

        console.log(
          `[CLEANUP] Removed job ${id}`
        );
      }
    }

  },
  10 * 60 * 1000
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "      RECAP ONE CLIP V3"
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
      `Fallback Models: ${FALLBACK_MODELS.join(", ")}`
    );

    console.log(
      `FFmpeg: ${
        ffmpegPath
          ? "READY"
          : "MISSING"
      }`
    );

    console.log(
      `FFprobe: ${
        ffprobePath
          ? "READY"
          : "MISSING"
      }`

    );

    console.log(
      "======================================"
    );
  }
);
