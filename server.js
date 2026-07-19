// ==================== server.js ====================
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "child_process";
import crypto from "crypto";
import fetch from "node-fetch";
import fs from "fs";
import admin from "firebase-admin";
import "dotenv/config";

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(helmet());

// ------------------- CORS 설정 -------------------
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
  })
);

// ------------------- Rate Limit -------------------
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many requests, please try again later." },
});

// ------------------- API 키 인증 -------------------
const API_KEY = process.env.ROSTER_API_KEY || process.env.API_KEY || "";
const firebaseAuthMode = String(process.env.ROSTER_REQUIRE_FIREBASE_AUTH || "true").trim().toLowerCase();
const REQUIRE_FIREBASE_AUTH = !["false", "0", "no"].includes(firebaseAuthMode);

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireApiKey(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: "ROSTER_API_KEY is not configured" });
    return false;
  }

  const auth = req.headers["x-api-key"];
  if (!auth || !timingSafeEqualText(auth, API_KEY)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  return true;
}

function readConfigValue(name) {
  if (process.env[name]) return process.env[name];

  const secretPath = `/etc/secrets/${name}`;
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, "utf8").trim();

  return "";
}

function parseJsonConfig(name, value) {
  const parsed = JSON.parse(value);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

function initializeFirebaseAdmin() {
  if (admin.apps.length) return;

  const raw = readConfigValue("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is required when Firebase auth is enabled");

  admin.initializeApp({
    credential: admin.credential.cert(parseJsonConfig("FIREBASE_SERVICE_ACCOUNT", raw)),
  });
}

async function verifiedFirebaseUser(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    if (!REQUIRE_FIREBASE_AUTH) return { uid: "", email: "" };

    const error = new Error("Firebase ID token required");
    error.statusCode = 401;
    throw error;
  }

  initializeFirebaseAdmin();
  const decoded = await admin.auth().verifyIdToken(match[1]);
  return {
    uid: decoded.uid || "",
    email: decoded.email || "",
  };
}

// ------------------- 민감정보 마스킹 -------------------
function mask(str, username, password) {
  if (!str) return str;
  return str
    .split(username || "").join("[REDACTED]")
    .split(password || "").join("[REDACTED]");
}

function normalizeCredential(value) {
  let normalized = String(value || "").trim();
  for (let i = 0; i < 3; i++) {
    const startsAndEndsWithDouble = normalized.startsWith("\"") && normalized.endsWith("\"");
    const startsAndEndsWithSingle = normalized.startsWith("'") && normalized.endsWith("'");
    if (!startsAndEndsWithDouble && !startsAndEndsWithSingle) break;
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function hasAspNetRequestValidationRisk(value) {
  return /<|>|&#|&lt;|&gt;|%3c|%3e/i.test(String(value || ""));
}

const DEFAULT_FIREBASE_UID = "khbM4wQw52YpY9SrUpoAcG3umqT2";

function validFirebaseUid(value) {
  const uid = String(value || "").trim();
  if (!uid || uid === "your_admin_uid") return "";
  return uid;
}

function resolveRunUids({ authUid, firebaseUid }) {
  if (REQUIRE_FIREBASE_AUTH || authUid) {
    const verifiedUid = validFirebaseUid(authUid);
    if (!verifiedUid) {
      const error = new Error("Verified Firebase UID is required");
      error.statusCode = 401;
      throw error;
    }
    return { runFirebaseUid: verifiedUid, runAdminUid: verifiedUid };
  }

  const runFirebaseUid =
    validFirebaseUid(firebaseUid) ||
    validFirebaseUid(process.env.FIREBASE_UID) ||
    DEFAULT_FIREBASE_UID;
  const runAdminUid =
    validFirebaseUid(firebaseUid) ||
    validFirebaseUid(process.env.INPUT_ADMIN_FIREBASE_UID) ||
    validFirebaseUid(process.env.ADMIN_FIREBASE_UID) ||
    validFirebaseUid(process.env.FIREBASE_UID) ||
    DEFAULT_FIREBASE_UID;

  return { runFirebaseUid, runAdminUid };
}

// ------------------- POST /runRoster -------------------
app.post("/runRoster", limiter, async (req, res) => {
  try {
    if (!requireApiKey(req, res)) return;

    const { firebaseUid } = req.body || {};
    const authUser = await verifiedFirebaseUser(req);
    const authUid = authUser.uid || "";
    const asyncMode = req.body?.async === true || req.body?.waitForResult === false;
    const username = normalizeCredential(req.body?.username);
    const password = normalizeCredential(req.body?.password);
    if (!username || !password)
      return res.status(400).json({ error: "username and password required" });
    if (hasAspNetRequestValidationRisk(username)) {
      return res.status(400).json({
        error: "username contains characters CrewConnex rejects. Remove <, >, HTML/XML-like text, or encoded angle brackets.",
      });
    }
    if (hasAspNetRequestValidationRisk(password)) {
      return res.status(400).json({
        error: "password contains characters CrewConnex rejects. Change the CrewConnex password to avoid <, >, HTML/XML-like text, or encoded angle brackets.",
      });
    }

    console.log(`📤 Run roster.js from ${req.ip}`);

    const { runFirebaseUid, runAdminUid } = resolveRunUids({ authUid, firebaseUid });

    const env = {
      ...process.env,
      INPUT_PDC_USERNAME: username,
      INPUT_PDC_PASSWORD: password,
      INPUT_FIREBASE_UID: runFirebaseUid,
      INPUT_ADMIN_FIREBASE_UID: runAdminUid,
      FIREBASE_UID: runFirebaseUid,
      USER_ID: authUser.email || process.env.USER_ID || "",
      CHROME_PATH: process.env.CHROME_PATH || "",
    };

    const child = spawn("node", ["./roster.js"], { env });
    let out = "", err = "";

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    if (asyncMode) {
      res.status(202).json({
        ok: true,
        status: "started",
        message: "Roster sync started. Check Render logs, Firestore, or Google Sheets for completion.",
      });
    }

    child.on("close", (code) => {
      console.log(`✅ roster.js finished (exit ${code})`);
      const result = {
        exitCode: code,
        stdout: mask(out, username, password),
        stderr: mask(err, username, password),
      };
      if (asyncMode) {
        console.log("📦 Async roster result:", result);
        return;
      }
      res.json(result);
    });

    child.on("error", (error) => {
      console.error("❌ Spawn error:", error);
      if (!res.headersSent) res.status(500).json({ error: error.message });
    });
  } catch (e) {
    console.error("❌ Server error:", e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ------------------- POST /triggerWorkflow -------------------
app.post("/triggerWorkflow", limiter, async (req, res) => {
  try {
    if (!requireApiKey(req, res)) return;

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
        body: JSON.stringify({ ref: branch }),
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
