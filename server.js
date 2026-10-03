// ============================================================
// RECAP ONE CLIP V1
// Myanmar AI Recap Studio
// Render Backend
// ============================================================

require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const googleTTS = require("google-tts-api");

const app = express();

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const OUTPUT_DIR = path.join(ROOT_DIR, "outputs");

const MAX_FILE_SIZE = 700 * 1024 * 1024;
const MAX_DURATION = 5 * 60;

// ============================================================
// CREATE DIRECTORIES
// ============================================================

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ============================================================
// CORS
// ============================================================

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// MULTER
// ============================================================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    const name =
      Date.now() +
      "-" +
      crypto.randomBytes(6).toString("hex") +
      ext;

    cb(null, name);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE,
  },

  fileFilter: function (req, file, cb) {
    const allowed = [
      ".mp4",
      ".mov",
      ".webm",
      ".mkv",
    ];

    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowed.includes(ext)) {
      return cb(
        new Error(
          "Only MP4, MOV, WEBM and MKV files are supported"
        )
      );
    }

    cb(null, true);
  },
});

// ============================================================
// JOB STORAGE
// ============================================================

const jobs = new Map();

// ============================================================
// HELPERS
// ============================================================

function makeId() {
  return crypto.randomUUID();
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    console.log("Cleanup error:", err.message);
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({
          stdout,
          stderr,
        });
      }
    );
  });
}

// ============================================================
// VIDEO DURATION
// ============================================================

async function getVideoDuration(filePath) {
  const result = await runCommand(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);

  const duration = Number(result.stdout.trim());

  if (!Number.isFinite(duration)) {
    throw new Error("Unable to read video duration");
  }

  return duration;
}

// ============================================================
// FALLBACK MYANMAR RECAP
// ============================================================

function createMyanmarRecap(notes = "") {
  const extra = notes
    ? `\n\nအထူးမှတ်ချက် — ${notes}`
    : "";

  return `
ဒီဇာတ်လမ်းကို အစပိုင်းမှာ အဓိကဇာတ်ကောင်နဲ့ သူ့ရဲ့အခြေအနေကို မိတ်ဆက်ပေးထားပါတယ်။

ဇာတ်လမ်း တဖြည်းဖြည်းတိုးတက်လာတဲ့အခါ မမျှော်လင့်ထားတဲ့ အခြေအနေတစ်ခု ပေါ်ပေါက်လာပြီး အဓိကဇာတ်ကောင်ဟာ ဆုံးဖြတ်ချက်တစ်ခု ချမှတ်ရပါတော့တယ်။

အဲဒီနောက်ပိုင်းမှာ ပြဿနာတွေ တစ်ဆင့်ပြီးတစ်ဆင့် ပိုမိုရှုပ်ထွေးလာပါတယ်။ ဇာတ်ကောင်တွေကြားက ဆက်ဆံရေးတွေ ပြောင်းလဲလာပြီး အမှန်တရားကို ရှာဖွေဖို့ ကြိုးစားလာကြပါတယ်။

နောက်ဆုံးပိုင်းမှာ အဓိကပြဿနာကို ဖြေရှင်းဖို့ အရေးကြီးတဲ့ အဖြစ်အပျက်တစ်ခု ဖြစ်ပေါ်လာပါတယ်။

ဒီဇာတ်လမ်းရဲ့ အဓိကအချက်ကတော့ အခက်အခဲတွေကြားမှာ လူတစ်ယောက်ဟာ ကိုယ့်ရဲ့ဆုံးဖြတ်ချက်တွေအတွက် တာဝန်ယူရပြီး နောက်ဆုံးမှာ ကိုယ့်ရဲ့လုပ်ရပ်တွေရဲ့ အကျိုးဆက်ကို ရင်ဆိုင်ရတာပဲ ဖြစ်ပါတယ်။
${extra}
`.trim();
}

// ============================================================
// TTS
// ============================================================

async function createMyanmarVoice(text, outputFile) {
  const chunks = text
    .replace(/\s+/g, " ")
    .match(/.{1,180}/g) || [];

  const audioFiles = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i].trim();

    if (!chunk) continue;

    const urls = googleTTS.getAllAudioUrls(chunk, {
      lang: "my",
      slow: false,
      host: "https://translate.google.com",
    });

    const audioUrl = urls[0]?.url;

    if (!audioUrl) {
      throw new Error("Myanmar TTS URL could not be created");
    }

    const audioFile = path.join(
      OUTPUT_DIR,
      `tts-${Date.now()}-${i}.mp3`
    );

    const response = await fetch(audioUrl);

    if (!response.ok) {
      throw new Error("TTS download failed");
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    fs.writeFileSync(audioFile, buffer);

    audioFiles.push(audioFile);
  }

  if (!audioFiles.length) {
    throw new Error("No voice audio generated");
  }

  if (audioFiles.length === 1) {
    fs.copyFileSync(audioFiles[0], outputFile);
    safeUnlink(audioFiles[0]);
    return outputFile;
  }

  const listFile = path.join(
    OUTPUT_DIR,
    `tts-list-${Date.now()}.txt`
  );

  const listText = audioFiles
    .map((file) => {
      return `file '${file.replace(/'/g, "'\\''")}'`;
    })
    .join("\n");

  fs.writeFileSync(listFile, listText);

  await runCommand(ffmpegPath, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    outputFile,
  ]);

  safeUnlink(listFile);

  for (const file of audioFiles) {
    safeUnlink(file);
  }

  return outputFile;
}

// ============================================================
// SRT
// ============================================================

function secondsToSrtTime(seconds) {
  const totalMs = Math.max(0, Math.floor(seconds * 1000));

  const ms = totalMs % 1000;

  const totalSeconds = Math.floor(totalMs / 1000);

  const sec = totalSeconds % 60;

  const totalMinutes = Math.floor(totalSeconds / 60);

  const min = totalMinutes % 60;

  const hour = Math.floor(totalMinutes / 60);

  return (
    String(hour).padStart(2, "0") +
    ":" +
    String(min).padStart(2, "0") +
    ":" +
    String(sec).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

function createSRT(text, duration, outputFile) {
  const sentences = text
    .split(/(?<=[။!?])/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (!sentences.length) {
    sentences.push(text);
  }

  const segmentDuration = duration / sentences.length;

  let srt = "";

  sentences.forEach((sentence, index) => {
    const start = index * segmentDuration;

    const end =
      index === sentences.length - 1
        ? duration
        : (index + 1) * segmentDuration;

    srt += `${index + 1}\n`;
    srt += `${secondsToSrtTime(start)} --> ${secondsToSrtTime(end)}\n`;
    srt += `${sentence}\n\n`;
  });

  fs.writeFileSync(outputFile, srt, "utf8");

  return outputFile;
}

// ============================================================
// RENDER VIDEO
// ============================================================

async function renderFinalVideo(
  videoFile,
  audioFile,
  subtitleFile,
  outputFile
) {
  const subtitlePath = subtitleFile
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:");

  await runCommand(ffmpegPath, [
    "-y",

    "-i",
    videoFile,

    "-i",
    audioFile,

    "-vf",
    `subtitles=${subtitlePath}`,

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

    "-c:a",
    "aac",

    "-b:a",
    "192k",

    "-movflags",
    "+faststart",

    "-shortest",

    outputFile,
  ]);

  return outputFile;
}

// ============================================================
// PROCESS JOB
// ============================================================

async function processJob(jobId, notes, voiceStyle) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  try {
    // --------------------------------------------------------
    // ANALYZING
    // --------------------------------------------------------

    job.status = "analyzing";
    job.progress = 15;
    job.message = "Video ကို စစ်ဆေးနေပါတယ်";

    const duration = await getVideoDuration(job.inputPath);

    job.duration = duration;

    if (duration > MAX_DURATION) {
      throw new Error(
        "Video duration must be 5 minutes or less"
      );
    }

    // --------------------------------------------------------
    // WRITING
    // --------------------------------------------------------

    job.status = "writing";
    job.progress = 30;
    job.message = "Myanmar recap script ရေးနေပါတယ်";

    // Current V1 fallback engine
    const recapText = createMyanmarRecap(notes);

    job.script = recapText;

    // --------------------------------------------------------
    // VOICE
    // --------------------------------------------------------

    job.status = "voice";
    job.progress = 50;
    job.message = "Myanmar narration ဖန်တီးနေပါတယ်";

    const audioFile = path.join(
      OUTPUT_DIR,
      `${jobId}-voice.mp3`
    );

    await createMyanmarVoice(
      recapText,
      audioFile
    );

    job.audioPath = audioFile;

    // --------------------------------------------------------
    // SUBTITLE
    // --------------------------------------------------------

    job.status = "subtitle";
    job.progress = 65;
    job.message = "Myanmar subtitle ပြင်ဆင်နေပါတယ်";

    const subtitleFile = path.join(
      OUTPUT_DIR,
      `${jobId}.srt`
    );

    createSRT(
      recapText,
      duration,
      subtitleFile
    );

    job.subtitlePath = subtitleFile;

    // --------------------------------------------------------
    // RENDER
    // --------------------------------------------------------

    job.status = "rendering";
    job.progress = 80;
    job.message = "Final MP4 ပြုလုပ်နေပါတယ်";

    const outputFile = path.join(
      OUTPUT_DIR,
      `${jobId}-recap.mp4`
    );

    await renderFinalVideo(
      job.inputPath,
      audioFile,
      subtitleFile,
      outputFile
    );

    // --------------------------------------------------------
    // COMPLETE
    // --------------------------------------------------------

    job.status = "complete";
    job.progress = 100;
    job.message = "Recap ပြီးပါပြီ";

    job.outputUrl =
      `/outputs/${path.basename(outputFile)}`;

    job.script = recapText;

    console.log(
      `Job ${jobId} completed successfully`
    );
  } catch (error) {
    console.error(
      `Job ${jobId} failed:`,
      error
    );

    job.status = "error";
    job.progress = 0;
    job.message =
      error.message || "Processing failed";
  }
}

// ============================================================
// HEALTH
// ============================================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    app: "RECAP ONE CLIP V1",
    status: "online",
    serverTime: new Date().toISOString(),
  });
});

// ============================================================
// UPLOAD
// ============================================================

app.post(
  "/api/upload",
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Video file မတွေ့ပါ",
        });
      }

      const duration = await getVideoDuration(
        req.file.path
      );

      if (duration > MAX_DURATION) {
        safeUnlink(req.file.path);

        return res.status(400).json({
          success: false,
          message: "Video သည် 5 minutes ထက်မကျော်ရပါ",
        });
      }

      const id = makeId();

      jobs.set(id, {
        id,

        status: "uploaded",

        progress: 5,

        message: "Video upload ပြီးပါပြီ",

        originalName: req.file.originalname,

        inputPath: req.file.path,

        duration,

        createdAt: new Date().toISOString(),

        script: "",

        outputUrl: "",
      });

      res.json({
        success: true,

        jobId: id,

        duration,

        fileName: req.file.originalname,

        message: "Video upload successful",
      });
    } catch (error) {
      console.error(error);

      if (req.file) {
        safeUnlink(req.file.path);
      }

      res.status(500).json({
        success: false,
        message:
          error.message ||
          "Video upload failed",
      });
    }
  }
);

// ============================================================
// GENERATE
// ============================================================

app.post(
  "/api/generate/:id",
  async (req, res) => {
    const jobId = req.params.id;

    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job မတွေ့ပါ",
      });
    }

    if (
      job.status !== "uploaded" &&
      job.status !== "error"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "ဒီ video ကို processing လုပ်နေပြီးသားပါ",
      });
    }

    const notes =
      typeof req.body?.notes === "string"
        ? req.body.notes
        : "";

    const voiceStyle =
      typeof req.body?.voiceStyle === "string"
        ? req.body.voiceStyle
        : "cinematic";

    job.notes = notes;
    job.voiceStyle = voiceStyle;

    processJob(
      jobId,
      notes,
      voiceStyle
    );

    res.json({
      success: true,
      jobId,
      status: "started",
    });
  }
);

// ============================================================
// STATUS
// ============================================================

app.get(
  "/api/status/:id",
  (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job မတွေ့ပါ",
      });
    }

    res.json({
      success: true,

      jobId: job.id,

      status: job.status,

      progress: job.progress,

      message: job.message,

      duration: job.duration,

      script: job.script || "",

      outputUrl: job.outputUrl || "",

      originalName:
        job.originalName || "",
    });
  }
);

// ============================================================
// OUTPUT FILES
// ============================================================

app.use(
  "/outputs",
  express.static(OUTPUT_DIR)
);

// ============================================================
// ROOT
// IMPORTANT:
// index.html is in ROOT, NOT /public
// ============================================================

app.get("/", (req, res) => {
  const indexFile = path.join(
    ROOT_DIR,
    "index.html"
  );

  if (fs.existsSync(indexFile)) {
    return res.sendFile(indexFile);
  }

  res.status(404).send(
    "RECAP ONE CLIP V1 backend is running"
  );
});

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (err, req, res, next) => {
    console.error(err);

    if (
      err instanceof multer.MulterError
    ) {
      return res.status(400).json({
        success: false,
        message:
          err.message ||
          "Upload error",
      });
    }

    res.status(500).json({
      success: false,
      message:
        err.message ||
        "Server error",
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "===================================="
  );

  console.log(
    "      RECAP ONE CLIP V1"
  );

  console.log(
    "      Myanmar AI Recap Studio"
  );

  console.log(
    "===================================="
  );

  console.log(
    `Server running on port ${PORT}`
  );
});
