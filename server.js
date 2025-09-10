import express from "express";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.API_KEY || "change_me";

// ------------------- Roster 실행 API -------------------
app.post("/runRoster", async (req, res) => {
  try {
    // API 키 검증
    const auth = req.headers["x-api-key"];
    if (!auth || auth !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized: invalid API key" });
    }

    // 입력값 확인
    const { username, password, firebaseUid } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    // roster.js 실행 시 환경변수로 전달
    const env = {
      ...process.env,
      INPUT_PDC_USERNAME: username,
      INPUT_PDC_PASSWORD: password,
      FIREBASE_UID: firebaseUid || process.env.FIREBASE_UID,
    };

    const child = spawn("node", ["./roster.js"], { env });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("close", (code) => {
      // username/password는 로그에서 마스킹 처리
      const safeOut = out
        .replace(new RegExp(username, "g"), "[REDACTED]")
        .replace(new RegExp(password, "g"), "[REDACTED]");

      res.json({
        exitCode: code,
        stdout: safeOut,
        stderr: err ? "stderr exists (check server logs)" : "",
      });
    });
  } catch (e) {
    console.error("❌ Error in /runRoster:", e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------- 서버 실행 -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API listening on port ${PORT}`);
});
