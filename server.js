require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");

const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const googleTTS = require("google-tts-api");

const app = express();

const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");

for (const dir of [PUBLIC_DIR, UPLOAD_DIR, OUTPUT_DIR]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/outputs", express.static(OUTPUT_DIR));
app.use(express.static(PUBLIC_DIR));

const jobs = new Map();

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },

    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname || ".mp4");
        const name =
            Date.now() +
            "-" +
            crypto.randomBytes(5).toString("hex") +
            ext;

        cb(null, name);
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
            "video/quicktime",
            "video/webm",
            "video/x-matroska"
        ];

        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only MP4, MOV, WEBM or MKV videos are supported"));
        }
    }
});

function run(command, args) {
    return new Promise((resolve, reject) => {

        execFile(
            command,
            args,
            {
                maxBuffer: 50 * 1024 * 1024
            },
            (error, stdout, stderr) => {

                if (error) {
                    reject(
                        new Error(
                            stderr ||
                            stdout ||
                            error.message
                        )
                    );

                    return;
                }

                resolve({
                    stdout,
                    stderr
                });
            }
        );
    });
}

async function getVideoInfo(file) {

    const result = await run(ffprobePath, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file
    ]);

    const duration = Number(result.stdout.trim());

    if (!Number.isFinite(duration)) {
        throw new Error("Unable to read video duration");
    }

    return {
        duration
    };
}

function updateJob(id, data) {

    const job = jobs.get(id);

    if (!job) return;

    jobs.set(id, {
        ...job,
        ...data,
        updatedAt: Date.now()
    });
}

function cleanText(text) {

    return String(text || "")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function fallbackScript(duration) {

    const minutes = Math.max(1, Math.round(duration / 60));

    return `
ဒီ Video ထဲက အဖြစ်အပျက်တွေကို အစကနေ အဆုံးအထိ ပြန်လည်ရှင်းပြပေးသွားမှာဖြစ်ပါတယ်။

ဇာတ်လမ်းအစမှာ အဓိကအခြေအနေတွေကို စတင်တွေ့မြင်ရပြီး ဇာတ်ကောင်တွေကြားက ဖြစ်ပေါ်လာတဲ့ အခြေအနေတွေက ဇာတ်လမ်းကို တဖြည်းဖြည်းရှုပ်ထွေးလာစေပါတယ်။

အချိန်ကြာလာတာနဲ့အမျှ အရေးကြီးတဲ့ဖြစ်ရပ်တွေ ဆက်တိုက်ဖြစ်ပေါ်လာပြီး ဇာတ်ကောင်တွေရဲ့ ဆုံးဖြတ်ချက်တွေက နောက်ဆက်တွဲအဖြစ်အပျက်တွေကို ပြောင်းလဲသွားစေပါတယ်။

ဇာတ်လမ်းရဲ့အလယ်ပိုင်းမှာ ပြဿနာတွေ ပိုမိုပြင်းထန်လာပြီး မမျှော်လင့်ထားတဲ့ အခြေအနေတွေကို ရင်ဆိုင်ရပါတယ်။

နောက်ဆုံးပိုင်းမှာတော့ အစောပိုင်းက ဖြစ်ရပ်တွေနဲ့ ဆက်စပ်နေတဲ့ အချက်တွေ တဖြည်းဖြည်းပေါ်လာပြီး ဇာတ်လမ်းရဲ့ အဓိကအကြောင်းအရာကို နားလည်လာနိုင်ပါတယ်။

ဒီ Video ရဲ့ စုစုပေါင်းကြာချိန်က ခန့်မှန်းခြေအားဖြင့် ${minutes} မိနစ်ခန့် ဖြစ်ပါတယ်။
`.trim();
}

function splitSentences(text) {

    return cleanText(text)
        .split(/(?<=[။!?])/)
        .map(x => x.trim())
        .filter(Boolean);
}

function createSRT(text, duration) {

    const sentences = splitSentences(text);

    if (!sentences.length) {
        return "";
    }

    const weights = sentences.map(
        s => Math.max(1, s.length)
    );

    const totalWeight = weights.reduce(
        (a, b) => a + b,
        0
    );

    let current = 0;
    let output = "";

    function timestamp(seconds) {

        const ms = Math.floor(
            (seconds % 1) * 1000
        );

        const totalSeconds =
            Math.floor(seconds);

        const sec =
            totalSeconds % 60;

        const min =
            Math.floor(totalSeconds / 60) % 60;

        const hour =
            Math.floor(totalSeconds / 3600);

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

    sentences.forEach((sentence, index) => {

        const segment =
            duration *
            (weights[index] / totalWeight);

        const start = current;
        const end =
            Math.min(
                duration,
                current + segment
            );

        output +=
            `${index + 1}\n` +
            `${timestamp(start)} --> ${timestamp(end)}\n` +
            `${sentence}\n\n`;

        current = end;
    });

    return output.trim();
}

async function createMyanmarVoice(text, outputFile) {

    const chunks = [];

    let remaining = cleanText(text);

    const MAX_LENGTH = 180;

    while (remaining.length > 0) {

        let chunk = remaining.slice(
            0,
            MAX_LENGTH
        );

        if (remaining.length > MAX_LENGTH) {

            const lastSpace =
                Math.max(
                    chunk.lastIndexOf(" "),
                    chunk.lastIndexOf("၊"),
                    chunk.lastIndexOf(" ")
                );

            if (lastSpace > 60) {
                chunk = chunk.slice(
                    0,
                    lastSpace
                );
            }
        }

        chunks.push(chunk);

        remaining =
            remaining.slice(chunk.length).trim();
    }

    const audioFiles = [];

    for (let i = 0; i < chunks.length; i++) {

        const url =
            googleTTS.getAudioUrl(
                chunks[i],
                {
                    lang: "my",
                    slow: false,
                    host: "https://translate.google.com"
                }
            );

        const audioFile =
            path.join(
                OUTPUT_DIR,
                `tts-${Date.now()}-${i}.mp3`
            );

        const response =
            await fetch(url);

        if (!response.ok) {
            throw new Error(
                "Myanmar voice generation failed"
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

        audioFiles.push(audioFile);
    }

    if (audioFiles.length === 1) {

        fs.copyFileSync(
            audioFiles[0],
            outputFile
        );

    } else {

        const listFile =
            path.join(
                OUTPUT_DIR,
                `tts-list-${Date.now()}.txt`
            );

        const listContent =
            audioFiles
                .map(file =>
                    `file '${file.replace(/'/g, "'\\''")}'`
                )
                .join("\n");

        fs.writeFileSync(
            listFile,
            listContent
        );

        await run(ffmpegPath, [
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
        ]);
    }

    return outputFile;
}

async function renderFinalVideo(
    videoFile,
    voiceFile,
    subtitleFile,
    outputFile
) {

    await run(ffmpegPath, [
        "-y",

        "-i",
        videoFile,

        "-i",
        voiceFile,

        "-map",
        "0:v:0",

        "-map",
        "1:a:0",

        "-vf",
        `subtitles=${subtitleFile.replace(/\\/g, "/")}`,

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

        outputFile
    ]);
}

async function processJob(id) {

    const job = jobs.get(id);

    if (!job) {
        return;
    }

    try {

        updateJob(id, {
            status: "analyzing",
            progress: 10,
            message: "Video ကို စစ်ဆေးနေပါတယ်"
        });

        const info =
            await getVideoInfo(
                job.inputFile
            );

        if (info.duration > 300) {

            throw new Error(
                "V1 မှာ Video အရှည်ဆုံး 5 မိနစ်အထိသာ support လုပ်ထားပါတယ်"
            );
        }

        updateJob(id, {
            duration: info.duration,
            progress: 20,
            message: "Video analysis ပြီးပါပြီ"
        });

        updateJob(id, {
            status: "writing",
            progress: 35,
            message: "Myanmar recap script ပြုလုပ်နေပါတယ်"
        });

        /*
          V1 fallback mode
          နောက်အဆင့်မှာ ဒီနေရာကို Gemini Vision
          analysis နဲ့ upgrade လုပ်မယ်
        */

        const script =
            fallbackScript(
                info.duration
            );

        const scriptFile =
            path.join(
                OUTPUT_DIR,
                `${id}.txt`
            );

        fs.writeFileSync(
            scriptFile,
            script,
            "utf8"
        );

        updateJob(id, {
            script,
            progress: 50,
            message: "Recap script အဆင်သင့်ဖြစ်ပါပြီ"
        });

        updateJob(id, {
            status: "voice",
            progress: 60,
            message: "Myanmar narration ပြုလုပ်နေပါတယ်"
        });

        const voiceFile =
            path.join(
                OUTPUT_DIR,
                `${id}-voice.mp3`
            );

        await createMyanmarVoice(
            script,
            voiceFile
        );

        updateJob(id, {
            progress: 70,
            message: "Myanmar voice အဆင်သင့်ဖြစ်ပါပြီ"
        });

        updateJob(id, {
            status: "subtitle",
            progress: 78,
            message: "Myanmar subtitle ပြုလုပ်နေပါတယ်"
        });

        const srt =
            createSRT(
                script,
                info.duration
            );

        const subtitleFile =
            path.join(
                OUTPUT_DIR,
                `${id}.srt`
            );

        fs.writeFileSync(
            subtitleFile,
            srt,
            "utf8"
        );

        updateJob(id, {
            progress: 84,
            message: "Subtitle အဆင်သင့်ဖြစ်ပါပြီ"
        });

        updateJob(id, {
            status: "rendering",
            progress: 90,
            message: "Final MP4 ပြုလုပ်နေပါတယ်"
        });

        const finalFile =
            path.join(
                OUTPUT_DIR,
                `${id}-recap.mp4`
            );

        await renderFinalVideo(
            job.inputFile,
            voiceFile,
            subtitleFile,
            finalFile
        );

        updateJob(id, {
            status: "complete",
            progress: 100,
            message: "Recap Video ပြီးပါပြီ",
            outputUrl:
                `/outputs/${id}-recap.mp4`,
            subtitleUrl:
                `/outputs/${id}.srt`,
            scriptUrl:
                `/outputs/${id}.txt`
        });

    } catch (error) {

        console.error(error);

        updateJob(id, {
            status: "error",
            progress: 0,
            message: error.message ||
                "Processing failed"
        });
    }
}

app.get("/api/health", (req, res) => {

    res.json({
        ok: true,
        app: "RECAP ONE CLIP",
        version: "1.0.0"
    });
});

app.post(
    "/api/upload",
    upload.single("video"),
    async (req, res) => {

        try {

            if (!req.file) {
                return res.status(400).json({
                    error: "Video မရွေးထားပါ"
                });
            }

            const id =
                crypto
                    .randomBytes(8)
                    .toString("hex");

            const job = {

                id,

                originalName:
                    req.file.originalname,

                inputFile:
                    req.file.path,

                size:
                    req.file.size,

                mime:
                    req.file.mimetype,

                status:
                    "uploaded",

                progress:
                    5,

                message:
                    "Video upload ပြီးပါပြီ",

                createdAt:
                    Date.now(),

                updatedAt:
                    Date.now()
            };

            jobs.set(id, job);

            res.json({
                ok: true,
                id,
                status: job.status,
                progress: job.progress
            });

        } catch (error) {

            res.status(500).json({
                error: error.message
            });
        }
    }
);

app.post(
    "/api/generate/:id",
    async (req, res) => {

        const id =
            req.params.id;

        const job =
            jobs.get(id);

        if (!job) {

            return res.status(404).json({
                error: "Job မတွေ့ပါ"
            });
        }

        if (
            job.status !== "uploaded"
        ) {

            return res.status(400).json({
                error:
                    "ဒီ Video ကို processing လုပ်နေပြီးသားဖြစ်ပါတယ်"
            });
        }

        updateJob(id, {
            status: "analyzing",
            progress: 8,
            message: "Processing စတင်ပါပြီ"
        });

        processJob(id);

        res.json({
            ok: true,
            id
        });
    }
);

app.get(
    "/api/status/:id",
    (req, res) => {

        const job =
            jobs.get(
                req.params.id
            );

        if (!job) {

            return res.status(404).json({
                error: "Job မတွေ့ပါ"
            });
        }

        res.json({
            ok: true,
            ...job
        });
    }
);

app.use(
    (err, req, res, next) => {

        console.error(err);

        res.status(500).json({
            error:
                err.message ||
                "Server error"
        });
    }
);

app.get("*", (req, res) => {

    res.sendFile(
        path.join(
            PUBLIC_DIR,
            "index.html"
        )
    );
});

app.listen(PORT, () => {

    console.log("");
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
        `Server: http://localhost:${PORT}`
    );
    console.log("");
});
