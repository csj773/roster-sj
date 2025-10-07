// ==================== server.js ====================
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "child_process";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
app.use(express.json());
app.use(helmet());

// ------------------- CORS 설정 -------------------
app.use(
  cors({
    origin: [
      "https://your-flutterflow-app.web.app",
      "https://your-flutterflow-app.firebaseapp.com",
    ],
    methods: ["POST"],
  })
);

// ------------------- Rate Limit -------------------
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many requests, please try again later." },
});

// ------------------- 고정 API 키 -------------------
const API_KEY = "mysecret123"; // 여기서 고정

// ------------------- 민감정보 마스킹 -------------------
function mask(str, username, password) {
  if (!str) return str;
  return str
    .split(username || "").join("[REDACTED]")
    .split(password || "").join("[REDACTED]");
}

// ------------------- POST /runRoster -------------------
app.post("/runRoster", limiter, async (req, res) => {
  try {
    const auth = req.headers["x-api-key"];
    if (!auth || auth !== API_KEY)
      return res.status(401).json({ error: "Unauthorized" });

    const { username, password, firebaseUid } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: "username and password required" });

    console.log(`📤 Run roster.js from ${req.ip}`);

    const env = {
      ...process.env,
      INPUT_PDC_USERNAME: username,
      INPUT_PDC_PASSWORD: password,
      FIREBASE_UID: firebaseUid || process.env.FIREBASE_UID,
      CHROME_PATH: process.env.CHROME_PATH || "/usr/bin/chromium",
    };

    const child = spawn("node", ["./roster.js"], { env });
    let out = "", err = "";

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("close", (code) => {
      console.log(`✅ roster.js finished (exit ${code})`);
      res.json({
        exitCode: code,
        stdout: mask(out, username, password),
        stderr: mask(err, username, password),
      });
    });

    child.on("error", (error) => {
      console.error("❌ Spawn error:", error);
      res.status(500).json({ error: error.message });
    });
  } catch (e) {
    console.error("❌ Server error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------- POST /triggerWorkflow -------------------
app.post("/triggerWorkflow", limiter, async (req, res) => {
  try {
    const auth = req.headers["x-api-key"];
    if (!auth || auth !== API_KEY)
      return res.status(401).json({ error: "Unauthorized" });

    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: "username and password required" });

    const repoOwner = "csj773";
    const repoName = "roster-sj";
    const workflowFile = "update-roster.yml";
    const branch = "main";

    console.log(`🚀 Triggering GitHub workflow for ${username}...`);

    const response = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/${workflowFile}/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: branch,
          inputs: {
            PDC_USERNAME: username,
            PDC_PASSWORD: password,
          },
        }),
      }
    );

    const text = await response.text();

    if (!response.ok) {
      console.error("❌ GitHub API error:", text);
      return res.status(500).json({ error: "GitHub API error", details: text });
    }

    const workflowUrl = `https://github.com/${repoOwner}/${repoName}/actions`;
    res.json({
      ok: true,
      message: "Workflow triggered successfully",
      githubActionsUrl: workflowUrl,
    });
  } catch (e) {
    console.error("❌ triggerWorkflow error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------- 기본 라우트 -------------------
app.get("/", (req, res) => {
  res.send("✅ Roster API running successfully on Render.");
});

// ------------------- 서버 실행 -------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on Render port ${PORT}`);
});
