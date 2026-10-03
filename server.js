require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const util = require("util");

const { GoogleGenAI } = require("@google/genai");
const googleTTS = require("google-tts-api");

const execFileAsync = util.promisify(execFile);

const app = express();

const PORT = process.env.PORT || 10000;

const ROOT_DIR = __dirname;
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const OUTPUT_DIR = path.join(ROOT_DIR, "outputs");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/* =========================================================
   CONFIG
========================================================= */

const MAX_VIDEO_SECONDS = 5 * 60;
const MAX_FILE_SIZE = 700 * 1024 * 1024;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    })
  : null;


/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(
  cors({
    origin: true,
    credentials: false
  })
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);


/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({

  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },

  filename: function (req, file, cb) {

    const ext =
      path.extname(file.originalname || "")
        .toLowerCase() || ".mp4";

    const id =
      crypto.randomUUID();

    cb(
      null,
      id + ext
    );
  }

});

const upload = multer({

  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  }

});


/* =========================================================
   JOB STORE
========================================================= */

const jobs = new Map();


function createJob(file) {

  const id =
    crypto.randomUUID();

  const job = {

    id,

    originalName:
      file.originalname,

    filePath:
      file.path,

    mimeType:
      file.mimetype ||
      "video/mp4",

    status:
      "uploaded",

    stage:
      "analyze",

    progress:
      10,

    message:
      "Video uploaded",

    duration:
      0,

    script:
      "",

    analysis:
      "",

    audioPath:
      null,

    subtitlePath:
      null,

    outputPath:
      null,

    outputUrl:
      null,

    subtitleUrl:
      null,

    error:
      null,

    createdAt:
      Date.now(),

    updatedAt:
      Date.now()

  };

  jobs.set(id, job);

  return job;
}


function updateJob(id, values) {

  const job =
    jobs.get(id);

  if (!job) {
    return;
  }

  Object.assign(
    job,
    values,
    {
      updatedAt:
        Date.now()
    }
  );

}


/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


function escapeFilterPath(filePath) {

  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");

}


function cleanText(text) {

  if (!text) {
    return "";
  }

  return String(text)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\r/g, "")
    .trim();

}


/* =========================================================
   FFMPEG / FFPROBE
========================================================= */

function getFFmpegPath() {

  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }

}


function getFFprobePath() {

  try {
    return require("ffprobe-static").path;
  } catch {
    return "ffprobe";
  }

}


async function getVideoInfo(filePath) {

  const ffprobe =
    getFFprobePath();

  const result =
    await execFileAsync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        filePath
      ],
      {
        maxBuffer:
          1024 * 1024
      }
    );

  const data =
    JSON.parse(result.stdout);

  const duration =
    Number(
      data.format &&
      data.format.duration
    );

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {

    throw new Error(
      "Video duration ကို မဖတ်နိုင်ပါ"
    );

  }

  return {
    duration
  };

}


/* =========================================================
   GEMINI VIDEO ANALYSIS
========================================================= */

async function analyzeVideoWithGemini(job) {

  if (!ai) {

    throw new Error(
      "GEMINI_API_KEY မထည့်ရသေးပါ"
    );

  }

  updateJob(
    job.id,
    {
      stage:
        "analyze",

      progress:
        20,

      message:
        "Gemini က video ကို analyze လုပ်နေပါတယ်",

      status:
        "processing"
    }
  );


  /* -------------------------------------------------------
     Upload video to Gemini File API
  ------------------------------------------------------- */

  const uploadedFile =
    await ai.files.upload({
      file:
        job.filePath,

      config: {
        mimeType:
          job.mimeType
      }
    });


  /* -------------------------------------------------------
     Wait until Gemini processes video
  ------------------------------------------------------- */

  let videoFile =
    uploadedFile;

  let tries =
    0;

  while (
    videoFile.state === "PROCESSING"
  ) {

    tries++;

    if (tries > 120) {

      throw new Error(
        "Gemini video processing timeout"
      );

    }

    updateJob(
      job.id,
      {
        progress:
          Math.min(
            35,
            20 + tries * 0.12
          ),

        message:
          "Video analysis အတွက် ပြင်ဆင်နေပါတယ်"
      }
    );

    await sleep(3000);

    videoFile =
      await ai.files.get({
        name:
          videoFile.name
      });

  }


  if (
    videoFile.state === "FAILED"
  ) {

    throw new Error(
      "Gemini video processing failed"
    );

  }


  if (
    !videoFile.uri
  ) {

    throw new Error(
      "Gemini video URI မရပါ"
    );

  }


  /* -------------------------------------------------------
     Analyze actual video
  ------------------------------------------------------- */

  updateJob(
    job.id,
    {
      progress:
        40,

      message:
        "Scene, audio နဲ့ key events တွေကို စစ်ဆေးနေပါတယ်"
    }
  );


  const prompt = `
You are a professional movie/video recap analyst.

Analyze the uploaded video carefully.

Your task is to understand:
1. Main characters or people
2. Important visual events
3. Important dialogue or spoken information
4. Major scene changes
5. Cause and effect
6. Beginning, middle and ending
7. Important emotional moments
8. Important objects, locations or actions
9. Any important twist or reveal

Create a detailed chronological analysis.

IMPORTANT:
- Do not invent events that are not present
- Use timestamps whenever useful
- Focus on what is actually visible or audible
- Do not reproduce long copyrighted dialogue
- Do not reproduce the original screenplay
- Summarize and transform the content

Return the analysis in English first so another model step can reliably convert it into a Myanmar recap.

User notes:
${job.notes || "No additional notes"}
`;


  const response =
    await ai.models.generateContent({

      model:
        GEMINI_MODEL,

      contents: [
        {
          role:
            "user",

          parts: [

            {
              fileData: {
                fileUri:
                  videoFile.uri,

                mimeType:
                  videoFile.mimeType ||
                  job.mimeType
              }
            },

            {
              text:
                prompt
            }

          ]
        }
      ]

    });


  const analysis =
    cleanText(
      response.text
    );


  if (!analysis) {

    throw new Error(
      "Gemini က video analysis မထုတ်ပေးနိုင်ပါ"
    );

  }


  updateJob(
    job.id,
    {
      analysis,

      progress:
        45,

      message:
        "Video analysis ပြီးပါပြီ"
    }
  );


  /* -------------------------------------------------------
     Delete Gemini uploaded file when possible
  ------------------------------------------------------- */

  try {

    await ai.files.delete({
      name:
        videoFile.name
    });

  } catch (deleteError) {

    console.log(
      "Gemini file cleanup skipped:",
      deleteError.message
    );

  }


  return analysis;

}


/* =========================================================
   MYANMAR RECAP SCRIPT
========================================================= */

async function generateMyanmarScript(
  job,
  analysis
) {

  if (!ai) {

    throw new Error(
      "GEMINI_API_KEY မထည့်ရသေးပါ"
    );

  }

  updateJob(
    job.id,
    {
      stage:
        "script",

      progress:
        50,

      message:
        "Myanmar recap script ရေးနေပါတယ်"
    }
  );


  const style =
    job.voiceStyle ||
    "natural";


  const prompt = `
You are an expert Myanmar movie recap narrator.

Using the video analysis below, write a complete Myanmar-language
recap narration.

Requirements:

- Natural spoken Myanmar
- Easy for Myanmar viewers to understand
- Storytelling style
- Explain events in chronological order
- Focus on important plot points
- Explain character actions and consequences
- Keep the narration engaging
- Do not copy original movie dialogue
- Do not reproduce screenplay lines
- Do not invent scenes
- Do not mention that you are AI
- Do not use English unless a name or unavoidable technical term
- Write narration only
- Do not add headings
- Do not add bullet points
- Do not add timestamps
- Do not add quotation marks around the narration
- Do not end every sentence with formal Myanmar punctuation

Voice style:
${style}

Target video duration:
${Math.round(job.duration)} seconds

User notes:
${job.notes || "None"}

VIDEO ANALYSIS:
${analysis}
`;


  const response =
    await ai.models.generateContent({

      model:
        GEMINI_MODEL,

      contents:
        prompt

    });


  const script =
    cleanText(
      response.text
    );


  if (!script) {

    throw new Error(
      "Myanmar recap script မရပါ"
    );

  }


  updateJob(
    job.id,
    {
      script,

      progress:
        60,

      message:
        "Myanmar recap script အဆင်သင့်ဖြစ်ပါပြီ"
    }
  );


  return script;

}


/* =========================================================
   GOOGLE TTS
========================================================= */

async function createMyanmarVoice(
  job,
  script
) {

  updateJob(
    job.id,
    {
      stage:
        "voice",

      progress:
        65,

      message:
        "Myanmar narration voice ဖန်တီးနေပါတယ်"
    }
  );


  const chunks =
    splitTextForTTS(
      script,
      180
    );


  const audioFiles =
    [];


  for (
    let i = 0;
    i < chunks.length;
    i++
  ) {

    updateJob(
      job.id,
      {
        progress:
          65 +
          Math.round(
            (i / chunks.length) * 12
          ),

        message:
          `Myanmar voice ${i + 1}/${chunks.length}`
      }
    );


    const urls =
      googleTTS.getAllAudioUrls(
        chunks[i],
        {
          lang:
            "my",

          slow:
            false,

          host:
            "https://translate.google.com"
        }
      );


    if (
      !urls ||
      !urls.length
    ) {

      throw new Error(
        "Myanmar TTS audio URL မရပါ"
      );

    }


    const url =
      urls[0].url;


    const partPath =
      path.join(
        OUTPUT_DIR,
        `${job.id}-tts-${i}.mp3`
      );


    await downloadFile(
      url,
      partPath
    );


    audioFiles.push(
      partPath
    );

  }


  const listPath =
    path.join(
      OUTPUT_DIR,
      `${job.id}-audio-list.txt`
    );


  const listContent =
    audioFiles
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join("\n");


  fs.writeFileSync(
    listPath,
    listContent,
    "utf8"
  );


  const audioPath =
    path.join(
      OUTPUT_DIR,
      `${job.id}-voice.mp3`
    );


  const ffmpeg =
    getFFmpegPath();


  await execFileAsync(
    ffmpeg,
    [
      "-y",

      "-f",
      "concat",

      "-safe",
      "0",

      "-i",
      listPath,

      "-c:a",
      "libmp3lame",

      "-b:a",
      "128k",

      audioPath
    ],
    {
      maxBuffer:
        10 * 1024 * 1024
    }
  );


  updateJob(
    job.id,
    {
      audioPath,

      progress:
        78,

      message:
        "Myanmar narration voice ပြီးပါပြီ"
    }
  );


  return audioPath;

}


/* =========================================================
   TTS CHUNKING
========================================================= */

function splitTextForTTS(
  text,
  maxLength
) {

  const normalized =
    text
      .replace(/\s+/g, " ")
      .trim();


  if (
    normalized.length <=
    maxLength
  ) {

    return [
      normalized
    ];

  }


  const sentences =
    normalized.split(
      /(?<=[။.!?၊])\s+/
    );


  const chunks =
    [];

  let current =
    "";


  for (
    const sentence
    of sentences
  ) {

    if (
      (
        current +
        " " +
        sentence
      ).trim().length <=
      maxLength
    ) {

      current =
        (
          current +
          " " +
          sentence
        ).trim();

    } else {

      if (current) {
        chunks.push(
          current
        );
      }

      current =
        sentence.trim();

    }

  }


  if (current) {
    chunks.push(
      current
    );
  }


  return chunks;

}


/* =========================================================
   DOWNLOAD FILE
========================================================= */

async function downloadFile(
  url,
  destination
) {

  const response =
    await fetch(url);


  if (!response.ok) {

    throw new Error(
      `TTS download failed: ${response.status}`
    );

  }


  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );


  fs.writeFileSync(
    destination,
    buffer
  );

}


/* =========================================================
   SUBTITLE
========================================================= */

async function createSubtitle(
  job,
  script
) {

  updateJob(
    job.id,
    {
      stage:
        "subtitle",

      progress:
        82,

      message:
        "Myanmar subtitle ဖန်တီးနေပါတယ်"
    }
  );


  const sentences =
    splitForSubtitle(
      script
    );


  const totalChars =
    sentences.reduce(
      (
        total,
        sentence
      ) =>
        total +
        sentence.length,
      0
    );


  let cursor =
    0;


  const blocks =
    [];


  for (
    let i = 0;
    i < sentences.length;
    i++
  ) {

    const sentence =
      sentences[i];


    const start =
      job.duration *
      (
        cursor /
        Math.max(
          totalChars,
          1
        )
      );


    cursor +=
      sentence.length;


    const end =
      job.duration *
      (
        cursor /
        Math.max(
          totalChars,
          1
        )
      );


    blocks.push(
      [
        String(i + 1),

        `${toSrtTime(start)} --> ${toSrtTime(end)}`,

        sentence,

        ""
      ].join("\n")
    );

  }


  const subtitlePath =
    path.join(
      OUTPUT_DIR,
      `${job.id}.srt`
    );


  fs.writeFileSync(
    subtitlePath,
    blocks.join("\n"),
    "utf8"
  );


  updateJob(
    job.id,
    {
      subtitlePath,

      subtitleUrl:
        `/outputs/${job.id}.srt`,

      progress:
        87,

      message:
        "Myanmar subtitle အဆင်သင့်ဖြစ်ပါပြီ"
    }
  );


  return subtitlePath;

}


/* =========================================================
   SUBTITLE TEXT SPLIT
========================================================= */

function splitForSubtitle(
  text
) {

  const clean =
    text
      .replace(/\s+/g, " ")
      .trim();


  const raw =
    clean.split(
      /(?<=[။.!?])\s+/
    );


  const output =
    [];


  for (
    const item of raw
  ) {

    const sentence =
      item.trim();


    if (!sentence) {
      continue;
    }


    if (
      sentence.length <= 70
    ) {

      output.push(
        sentence
      );

      continue;

    }


    let current =
      "";


    const words =
      sentence.split(" ");


    for (
      const word of words
    ) {

      if (
        (
          current +
          " " +
          word
        ).trim().length <= 70
      ) {

        current =
          (
            current +
            " " +
            word
          ).trim();

      } else {

        if (current) {
          output.push(
            current
          );
        }

        current =
          word;

      }

    }


    if (current) {
      output.push(
        current
      );
    }

  }


  return output;

}


/* =========================================================
   SRT TIME
========================================================= */

function toSrtTime(
  seconds
) {

  seconds =
    Math.max(
      0,
      Number(seconds) || 0
    );


  const hours =
    Math.floor(
      seconds / 3600
    );


  const minutes =
    Math.floor(
      (seconds % 3600) / 60
    );


  const secs =
    Math.floor(
      seconds % 60
    );


  const ms =
    Math.floor(
      (
        seconds -
        Math.floor(seconds)
      ) *
      1000
    );


  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(secs).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );

}


/* =========================================================
   FINAL VIDEO RENDER
========================================================= */

async function renderFinalVideo(
  job
) {

  updateJob(
    job.id,
    {
      stage:
        "render",

      progress:
        90,

      message:
        "Final MP4 render လုပ်နေပါတယ်"
    }
  );


  const ffmpeg =
    getFFmpegPath();


  const outputPath =
    path.join(
      OUTPUT_DIR,
      `${job.id}-recap.mp4`
    );


  /*
    We burn the generated SRT onto the
    original video.

    Generated narration becomes the
    final audio track.
  */

  const subtitleFilter =
    escapeFilterPath(
      job.subtitlePath
    );


  const args = [

    "-y",

    "-i",
    job.filePath,

    "-i",
    job.audioPath,

    "-vf",
    `subtitles='${subtitleFilter}':force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=35'`,

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
    "128k",

    "-shortest",

    "-movflags",
    "+faststart",

    outputPath

  ];


  try {

    await execFileAsync(
      ffmpeg,
      args,
      {
        maxBuffer:
          30 * 1024 * 1024
      }
    );

  } catch (error) {

    console.error(
      "FFmpeg render error:",
      error.stderr ||
      error.message
    );


    /*
      Fallback:
      If subtitle filter is unavailable,
      create video with narration audio.
    */

    const fallbackArgs = [

      "-y",

      "-i",
      job.filePath,

      "-i",
      job.audioPath,

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
      "128k",

      "-shortest",

      "-movflags",
      "+faststart",

      outputPath

    ];


    await execFileAsync(
      ffmpeg,
      fallbackArgs,
      {
        maxBuffer:
          30 * 1024 * 1024
      }
    );

  }


  updateJob(
    job.id,
    {
      outputPath,

      outputUrl:
        `/outputs/${job.id}-recap.mp4`,

      progress:
        100,

      status:
        "completed",

      message:
        "Recap video အဆင်သင့်ဖြစ်ပါပြီ",

      stage:
        "done"
    }
  );


  return outputPath;

}


/* =========================================================
   COMPLETE PIPELINE
========================================================= */

async function processJob(
  job
) {

  try {

    updateJob(
      job.id,
      {
        status:
          "processing",

        stage:
          "analyze",

        progress:
          12
      }
    );


    const analysis =
      await analyzeVideoWithGemini(
        job
      );


    const script =
      await generateMyanmarScript(
        job,
        analysis
      );


    const audio =
      await createMyanmarVoice(
        job,
        script
      );


    job.audioPath =
      audio;


    const subtitle =
      await createSubtitle(
        job,
        script
      );


    job.subtitlePath =
      subtitle;


    await renderFinalVideo(
      job
    );


    /*
      Cleanup temporary TTS chunks
    */

    cleanupTemporaryFiles(
      job.id
    );


  } catch (error) {

    console.error(
      "JOB FAILED:",
      error
    );


    updateJob(
      job.id,
      {
        status:
          "failed",

        stage:
          "error",

        error:
          error.message ||
          "Processing failed",

        message:
          error.message ||
          "Processing failed"
      }
    );

  }

}


/* =========================================================
   CLEANUP
========================================================= */

function cleanupTemporaryFiles(
  jobId
) {

  try {

    const files =
      fs.readdirSync(
        OUTPUT_DIR
      );


    for (
      const file
      of files
    ) {

      if (
        file.startsWith(
          jobId + "-tts-"
        ) ||
        file ===
          `${jobId}-audio-list.txt`
      ) {

        try {

          fs.unlinkSync(
            path.join(
              OUTPUT_DIR,
              file
            )
          );

        } catch {}

      }

    }

  } catch {}

}


/* =========================================================
   API HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      ok:
        true,

      app:
        "RECAP ONE CLIP",

      version:
        "2.0.0",

      gemini:
        Boolean(GEMINI_API_KEY),

      model:
        GEMINI_MODEL

    });

  }
);


/* =========================================================
   API ROOT
========================================================= */

app.get(
  "/api",
  (req, res) => {

    res.json({

      app:
        "RECAP ONE CLIP",

      version:
        "2.0.0",

      endpoints: [

        "POST /api/upload",

        "POST /api/generate/:id",

        "GET /api/status/:id",

        "GET /api/health"

      ]

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

        return res
          .status(400)
          .json({
            error:
              "Video file မရပါ"
          });

      }


      const job =
        createJob(
          req.file
        );


      try {

        const info =
          await getVideoInfo(
            req.file.path
          );


        job.duration =
          info.duration;


        if (
          info.duration >
          MAX_VIDEO_SECONDS
        ) {

          fs.unlinkSync(
            req.file.path
          );


          jobs.delete(
            job.id
          );


          return res
            .status(400)
            .json({

              error:
                "Video duration က 5 minutes ထက် မကျော်ရပါ",

              duration:
                info.duration

            });

        }

      } catch (probeError) {

        try {

          fs.unlinkSync(
            req.file.path
          );

        } catch {}


        jobs.delete(
          job.id
        );


        return res
          .status(400)
          .json({

            error:
              probeError.message

          });

      }


      res.json({

        ok:
          true,

        jobId:
          job.id,

        id:
          job.id,

        status:
          job.status,

        duration:
          job.duration,

        fileName:
          job.originalName

      });

    } catch (error) {

      console.error(
        error
      );


      res
        .status(500)
        .json({

          error:
            error.message ||
            "Upload failed"

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

      return res
        .status(404)
        .json({

          error:
            "Job မတွေ့ပါ"

        });

    }


    if (
      job.status ===
      "processing"
    ) {

      return res.json({

        ok:
          true,

        message:
          "Job already processing",

        jobId:
          job.id

      });

    }


    job.notes =
      String(
        req.body.notes ||
        ""
      ).slice(
        0,
        5000
      );


    job.voiceStyle =
      String(
        req.body.voiceStyle ||
        "natural"
      );


    if (!GEMINI_API_KEY) {

      return res
        .status(500)
        .json({

          error:
            "Render Environment Variables ထဲမှာ GEMINI_API_KEY မရှိပါ"

        });

    }


    res.json({

      ok:
        true,

      jobId:
        job.id,

      status:
        "processing"

    });


    /*
      Run asynchronously so the browser
      does not need to keep the POST
      request open.
    */

    processJob(
      job
    );

  }
);


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

      return res
        .status(404)
        .json({

          error:
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

      stage:
        job.stage,

      progress:
        job.progress,

      percent:
        job.progress,

      message:
        job.message,

      duration:
        job.duration,

      outputUrl:
        job.outputUrl,

      subtitleUrl:
        job.subtitleUrl,

      error:
        job.error

    });

  }
);


/* =========================================================
   OUTPUTS
========================================================= */

app.use(
  "/outputs",
  express.static(
    OUTPUT_DIR,
    {
      fallthrough:
        false,

      maxAge:
        "1h"
    }
  )
);


/* =========================================================
   FRONTEND
========================================================= */

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


    res
      .status(404)
      .send(
        "RECAP ONE CLIP index.html not found"
      );

  }
);


/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {

    res
      .status(404)
      .json({

        error:
          "Route not found"

      });

  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {

    console.error(
      "SERVER ERROR:",
      error
    );


    if (
      error &&
      error.code ===
        "LIMIT_FILE_SIZE"
    ) {

      return res
        .status(413)
        .json({

          error:
            "Video file size က 700MB ထက် မကျော်ရပါ"

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


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "RECAP ONE CLIP V2"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Gemini:",
      GEMINI_API_KEY
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    );

    console.log(
      "Model:",
      GEMINI_MODEL
    );

    console.log(
      "======================================"
    );

  }
);
