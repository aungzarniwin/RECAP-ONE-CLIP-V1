// ============================================================
// RECAP ONE CLIP V1
// Myanmar AI Recap Studio
// BACKEND SERVER
// ============================================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const ffmpeg = require("ffmpeg-static");
const ffprobe = require("ffprobe-static").path;
const googleTTS = require("google-tts-api");

// ============================================================
// APP
// ============================================================

const app = express();

const PORT = process.env.PORT || 3000;

// ============================================================
// DIRECTORIES
// ============================================================

const ROOT_DIR = __dirname;

const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const OUTPUT_DIR = path.join(ROOT_DIR, "outputs");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, {
    recursive: true
  });
}

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, {
    recursive: true
  });
}

// ============================================================
// SETTINGS
// ============================================================

const MAX_FILE_SIZE = 700 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 5 * 60;

// ============================================================
// CORS
// ============================================================

app.use(
  cors({
    origin: true,
    methods: [
      "GET",
      "POST",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);

// ============================================================
// BODY
// ============================================================

app.use(
  express.json({
    limit: "20mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "20mb"
  })
);

// ============================================================
// JOB DATABASE
// ============================================================

const jobs = new Map();

// ============================================================
// MULTER
// ============================================================

const storage = multer.diskStorage({

  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {

    const extension =
      path.extname(file.originalname)
        .toLowerCase();

    const filename =
      Date.now() +
      "-" +
      crypto
        .randomBytes(8)
        .toString("hex") +
      extension;

    cb(null, filename);
  }
});

const upload = multer({

  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  },

  fileFilter: function (req, file, cb) {

    const allowedExtensions = [
      ".mp4",
      ".mov",
      ".webm",
      ".mkv"
    ];

    const extension =
      path.extname(file.originalname)
        .toLowerCase();

    if (
      !allowedExtensions.includes(
        extension
      )
    ) {

      return cb(
        new Error(
          "Only MP4, MOV, WEBM and MKV files are supported"
        )
      );
    }

    cb(null, true);
  }
});

// ============================================================
// HELPERS
// ============================================================

function createJobId() {

  return crypto.randomUUID();
}

// ------------------------------------------------------------

function deleteFile(filePath) {

  try {

    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }

  } catch (error) {

    console.log(
      "File cleanup error:",
      error.message
    );
  }
}

// ------------------------------------------------------------

function execute(command, args) {

  return new Promise(
    (resolve, reject) => {

      execFile(
        command,
        args,
        {
          maxBuffer:
            50 * 1024 * 1024
        },

        (error, stdout, stderr) => {

          if (error) {

            error.stdout =
              stdout;

            error.stderr =
              stderr;

            reject(error);

            return;
          }

          resolve({
            stdout,
            stderr
          });
        }
      );
    }
  );
}

// ============================================================
// VIDEO INFORMATION
// ============================================================

async function getVideoDuration(
  videoPath
) {

  const result =
    await execute(
      ffprobe,
      [
        "-v",
        "error",

        "-show_entries",
        "format=duration",

        "-of",
        "default=noprint_wrappers=1:nokey=1",

        videoPath
      ]
    );

  const duration =
    Number(
      result.stdout.trim()
    );

  if (
    !Number.isFinite(duration)
  ) {

    throw new Error(
      "Unable to read video duration"
    );
  }

  return duration;
}

// ============================================================
// RECAP SCRIPT
// ============================================================

function generateMyanmarRecap(
  notes = ""
) {

  let script = `
ဒီဗီဒီယိုရဲ့ ဇာတ်လမ်းကို အစပိုင်းမှာ အဓိကဇာတ်ကောင်တွေနဲ့ သူတို့ရဲ့အခြေအနေကို မိတ်ဆက်ပေးထားပါတယ်

ဇာတ်လမ်းတဖြည်းဖြည်း တိုးတက်လာတဲ့အခါ မမျှော်လင့်ထားတဲ့ ပြဿနာတစ်ခု ပေါ်ပေါက်လာပြီး အဓိကဇာတ်ကောင်ဟာ အရေးကြီးတဲ့ ဆုံးဖြတ်ချက်တစ်ခု ချမှတ်ရပါတော့တယ်

အဲဒီနောက်မှာ အဖြစ်အပျက်တွေ တစ်ဆင့်ပြီးတစ်ဆင့် ပိုမိုရှုပ်ထွေးလာပါတယ်

ဇာတ်ကောင်တွေရဲ့ ဆက်ဆံရေးတွေ ပြောင်းလဲလာပြီး အမှန်တရားကို ရှာဖွေဖို့ ကြိုးစားလာကြပါတယ်

ပြဿနာတွေ ပိုမိုကြီးမားလာတဲ့အချိန်မှာ အဓိကဇာတ်ကောင်ဟာ အခက်အခဲတွေကို ရင်ဆိုင်ပြီး ကိုယ့်ရဲ့ဆုံးဖြတ်ချက်တွေအတွက် တာဝန်ယူရပါတော့တယ်

နောက်ဆုံးမှာ အရေးကြီးတဲ့ အဖြစ်အပျက်တစ်ခု ဖြစ်ပေါ်လာပြီး ဇာတ်လမ်းရဲ့ အဓိကပဋိပက္ခကို ဖြေရှင်းဖို့ အခြေအနေတွေ ပြောင်းလဲသွားပါတယ်

ဒီဇာတ်လမ်းက အခက်အခဲတွေကြားမှာ ဆုံးဖြတ်ချက်တစ်ခုချင်းစီရဲ့ အကျိုးဆက်ကို ရင်ဆိုင်ရပုံကို အဓိကဖော်ပြထားတာ ဖြစ်ပါတယ်
`.trim();

  if (notes.trim()) {

    script +=
      "\n\n" +
      "အထူးမှတ်ချက် — " +
      notes.trim();
  }

  return script;
}

// ============================================================
// TTS
// ============================================================

async function generateVoice(
  text,
  outputFile
) {

  const chunks =
    text
      .replace(/\s+/g, " ")
      .match(/.{1,180}/g) || [];

  const audioFiles = [];

  for (
    let i = 0;
    i < chunks.length;
    i++
  ) {

    const chunk =
      chunks[i].trim();

    if (!chunk) {
      continue;
    }

    const urls =
      googleTTS.getAllAudioUrls(
        chunk,
        {
          lang: "my",
          slow: false,
          host:
            "https://translate.google.com"
        }
      );

    if (
      !urls ||
      !urls.length ||
      !urls[0].url
    ) {

      throw new Error(
        "Myanmar voice URL could not be generated"
      );
    }

    const audioURL =
      urls[0].url;

    const audioFile =
      path.join(
        OUTPUT_DIR,
        `voice-${Date.now()}-${i}.mp3`
      );

    const response =
      await fetch(audioURL);

    if (!response.ok) {

      throw new Error(
        "Myanmar voice download failed"
      );
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    fs.writeFileSync(
      audioFile,
      buffer
    );

    audioFiles.push(
      audioFile
    );
  }

  if (!audioFiles.length) {

    throw new Error(
      "No voice audio was generated"
    );
  }

  // One audio file
  if (
    audioFiles.length === 1
  ) {

    fs.copyFileSync(
      audioFiles[0],
      outputFile
    );

    deleteFile(
      audioFiles[0]
    );

    return outputFile;
  }

  // Multiple audio files
  const listFile =
    path.join(
      OUTPUT_DIR,
      `voice-list-${Date.now()}.txt`
    );

  const listContent =
    audioFiles
      .map(
        file =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n");

  fs.writeFileSync(
    listFile,
    listContent
  );

  await execute(
    ffmpeg,
    [
      "-y",

      "-f",
      "concat",

      "-safe",
      "0",

      "-i",
      listFile,

      "-c",
      "copy",

      outputFile
    ]
  );

  deleteFile(listFile);

  for (
    const file of audioFiles
  ) {
    deleteFile(file);
  }

  return outputFile;
}

// ============================================================
// SRT TIME
// ============================================================

function formatSRTTime(
  seconds
) {

  const milliseconds =
    Math.max(
      0,
      Math.floor(
        seconds * 1000
      )
    );

  const ms =
    milliseconds % 1000;

  const totalSeconds =
    Math.floor(
      milliseconds / 1000
    );

  const sec =
    totalSeconds % 60;

  const totalMinutes =
    Math.floor(
      totalSeconds / 60
    );

  const min =
    totalMinutes % 60;

  const hour =
    Math.floor(
      totalMinutes / 60
    );

  return (
    String(hour).padStart(
      2,
      "0"
    ) +
    ":" +
    String(min).padStart(
      2,
      "0"
    ) +
    ":" +
    String(sec).padStart(
      2,
      "0"
    ) +
    "," +
    String(ms).padStart(
      3,
      "0"
    )
  );
}

// ============================================================
// CREATE SUBTITLE
// ============================================================

function generateSubtitle(
  script,
  duration,
  outputFile
) {

  const sentences =
    script
      .split(/(?<=[။!?])/)
      .map(
        item => item.trim()
      )
      .filter(Boolean);

  if (!sentences.length) {

    sentences.push(script);
  }

  const timePerSentence =
    duration /
    sentences.length;

  let srt = "";

  sentences.forEach(
    (sentence, index) => {

      const start =
        index *
        timePerSentence;

      const end =
        index ===
        sentences.length - 1
          ? duration
          : (index + 1) *
            timePerSentence;

      srt +=
        `${index + 1}\n`;

      srt +=
        `${formatSRTTime(
          start
        )} --> ${formatSRTTime(
          end
        )}\n`;

      srt +=
        `${sentence}\n\n`;
    }
  );

  fs.writeFileSync(
    outputFile,
    srt,
    "utf8"
  );

  return outputFile;
}

// ============================================================
// FINAL VIDEO
// ============================================================

async function renderVideo(
  videoFile,
  audioFile,
  subtitleFile,
  outputFile
) {

  const subtitlePath =
    subtitleFile
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:");

  await execute(
    ffmpeg,
    [
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

      outputFile
    ]
  );

  return outputFile;
}

// ============================================================
// PROCESS JOB
// ============================================================

async function processJob(
  jobId,
  notes,
  voiceStyle
) {

  const job =
    jobs.get(jobId);

  if (!job) {
    return;
  }

  try {

    // --------------------------------------------------------
    // STEP 1
    // --------------------------------------------------------

    job.status =
      "analyzing";

    job.progress =
      15;

    job.message =
      "Video ကို စစ်ဆေးနေပါတယ်";

    const duration =
      await getVideoDuration(
        job.inputPath
      );

    job.duration =
      duration;

    if (
      duration >
      MAX_VIDEO_SECONDS
    ) {

      throw new Error(
        "Video duration must be 5 minutes or less"
      );
    }

    // --------------------------------------------------------
    // STEP 2
    // --------------------------------------------------------

    job.status =
      "writing";

    job.progress =
      30;

    job.message =
      "Myanmar recap script ရေးနေပါတယ်";

    const script =
      generateMyanmarRecap(
        notes
      );

    job.script =
      script;

    // --------------------------------------------------------
    // STEP 3
    // --------------------------------------------------------

    job.status =
      "voice";

    job.progress =
      50;

    job.message =
      "Myanmar narration ဖန်တီးနေပါတယ်";

    const voiceFile =
      path.join(
        OUTPUT_DIR,
        `${jobId}-voice.mp3`
      );

    await generateVoice(
      script,
      voiceFile
    );

    job.voicePath =
      voiceFile;

    // --------------------------------------------------------
    // STEP 4
    // --------------------------------------------------------

    job.status =
      "subtitle";

    job.progress =
      65;

    job.message =
      "Myanmar subtitle ပြုလုပ်နေပါတယ်";

    const subtitleFile =
      path.join(
        OUTPUT_DIR,
        `${jobId}.srt`
      );

    generateSubtitle(
      script,
      duration,
      subtitleFile
    );

    job.subtitlePath =
      subtitleFile;

    // --------------------------------------------------------
    // STEP 5
    // --------------------------------------------------------

    job.status =
      "rendering";

    job.progress =
      80;

    job.message =
      "Final MP4 ပြုလုပ်နေပါတယ်";

    const finalFile =
      path.join(
        OUTPUT_DIR,
        `${jobId}-recap.mp4`
      );

    await renderVideo(
      job.inputPath,
      voiceFile,
      subtitleFile,
      finalFile
    );

    // --------------------------------------------------------
    // DONE
    // --------------------------------------------------------

    job.status =
      "complete";

    job.progress =
      100;

    job.message =
      "Recap ပြီးပါပြီ";

    job.outputUrl =
      `/outputs/${path.basename(
        finalFile
      )}`;

    console.log(
      `Job ${jobId} completed`
    );

  } catch (error) {

    console.error(
      `Job ${jobId} error:`,
      error
    );

    job.status =
      "error";

    job.progress =
      0;

    job.message =
      error.message ||
      "Processing failed";
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/api/health",
  (req, res) => {

    res.json({
      ok: true,
      app: "RECAP ONE CLIP",
      version: "1.0.0",
      status: "online"
    });
  }
);

// ============================================================
// API INFO
// ============================================================

app.get(
  "/api",
  (req, res) => {

    res.json({

      app:
        "RECAP ONE CLIP",

      version:
        "1.0.0",

      status:
        "online",

      endpoints: {

        health:
          "/api/health",

        upload:
          "POST /api/upload",

        generate:
          "POST /api/generate/:id",

        status:
          "GET /api/status/:id"
      }
    });
  }
);

// ============================================================
// UPLOAD VIDEO
// ============================================================

app.post(
  "/api/upload",

  upload.single("video"),

  async (req, res) => {

    try {

      if (!req.file) {

        return res.status(400).json({
          ok: false,
          message:
            "Video file မတွေ့ပါ"
        });
      }

      const duration =
        await getVideoDuration(
          req.file.path
        );

      if (
        duration >
        MAX_VIDEO_SECONDS
      ) {

        deleteFile(
          req.file.path
        );

        return res.status(400).json({
          ok: false,
          message:
            "Video သည် 5 minutes ထက် မကျော်ရပါ"
        });
      }

      const jobId =
        createJobId();

      jobs.set(
        jobId,
        {

          id:
            jobId,

          status:
            "uploaded",

          progress:
            5,

          message:
            "Video upload ပြီးပါပြီ",

          originalName:
            req.file.originalname,

          inputPath:
            req.file.path,

          duration:
            duration,

          script:
            "",

          outputUrl:
            "",

          createdAt:
            new Date().toISOString()
        }
      );

      res.json({

        ok:
          true,

        jobId:
          jobId,

        duration:
          duration,

        fileName:
          req.file.originalname,

        message:
          "Video upload successful"
      });

    } catch (error) {

      console.error(
        "Upload error:",
        error
      );

      if (req.file) {

        deleteFile(
          req.file.path
        );
      }

      res.status(500).json({

        ok:
          false,

        message:
          error.message ||
          "Upload failed"
      });
    }
  }
);

// ============================================================
// GENERATE RECAP
// ============================================================

app.post(
  "/api/generate/:id",

  async (req, res) => {

    const jobId =
      req.params.id;

    const job =
      jobs.get(jobId);

    if (!job) {

      return res.status(404).json({

        ok:
          false,

        message:
          "Job မတွေ့ပါ"
      });
    }

    if (
      job.status !==
      "uploaded" &&
      job.status !==
      "error"
    ) {

      return res.status(400).json({

        ok:
          false,

        message:
          "ဒီ video ကို processing လုပ်နေပြီးသားပါ"
      });
    }

    const notes =
      typeof req.body?.notes ===
      "string"
        ? req.body.notes
        : "";

    const voiceStyle =
      typeof req.body?.voiceStyle ===
      "string"
        ? req.body.voiceStyle
        : "cinematic";

    job.notes =
      notes;

    job.voiceStyle =
      voiceStyle;

    // Start background processing
    processJob(
      jobId,
      notes,
      voiceStyle
    );

    res.json({

      ok:
        true,

      jobId:
        jobId,

      status:
        "started"
    });
  }
);

// ============================================================
// JOB STATUS
// ============================================================

app.get(
  "/api/status/:id",

  (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {

      return res.status(404).json({

        ok:
          false,

        message:
          "Job မတွေ့ပါ"
      });
    }

    res.json({

      ok:
        true,

      jobId:
        job.id,

      status:
        job.status,

      progress:
        job.progress,

      message:
        job.message,

      duration:
        job.duration,

      script:
        job.script || "",

      outputUrl:
        job.outputUrl || "",

      originalName:
        job.originalName || ""
    });
  }
);

// ============================================================
// OUTPUT FILES
// ============================================================

app.use(
  "/outputs",
  express.static(
    OUTPUT_DIR
  )
);

// ============================================================
// ROOT
// IMPORTANT:
// index.html is in ROOT
// NOT /public/index.html
// ============================================================

app.get(
  "/",
  (req, res) => {

    const indexPath =
      path.join(
        ROOT_DIR,
        "index.html"
      );

    if (
      fs.existsSync(
        indexPath
      )
    ) {

      return res.sendFile(
        indexPath
      );
    }

    res.status(200).send(
      `
      <h1>RECAP ONE CLIP V1</h1>
      <p>Backend is online</p>
      <p>API: /api/health</p>
      `
    );
  }
);

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "SERVER ERROR:",
      error
    );

    res.status(500).json({

      ok:
        false,

      message:
        error.message ||
        "Server error"
    });
  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

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

    console.log(
      "Root index:",
      path.join(
        ROOT_DIR,
        "index.html"
      )
    );

    console.log(
      "Upload directory:",
      UPLOAD_DIR
    );

    console.log(
      "Output directory:",
      OUTPUT_DIR
    );
  }
);
