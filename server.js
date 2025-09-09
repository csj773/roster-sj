import express from "express";
import { spawn } from "child_process";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

// 간단 인증키 (FlutterFlow에서 헤더에 같이 보냄)
const API_KEY = process.env.API_KEY || "change_me";

app.post("/runRoster", async (req, res) => {
  try {
    // 인증 체크
    const auth = req.headers["x-api-key"];
    if (!auth || auth !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { username, password, firebaseUid } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    // 환경변수 주입
    const env = {
      ...process.env,
      PDC_USERNAME: username,
      PDC_PASSWORD: password,
      FIREBASE_UID: firebaseUid || process.env.FIREBASE_UID,
    };

    // roster.js 절대 경로
    const rosterPath = path.resolve("./roster.js");

    // roster.js 실행
    const child = spawn("node", [rosterPath], { env });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("close", (code) => {
      // 민감정보 마스킹
      const maskSensitive = (text) =>
        text
          .replace(new RegExp(username, "g"), "[REDACTED_USER]")
          .replace(new RegExp(password, "g"), "[REDACTED_PASS]");

      res.json({
        code,
        stdout: maskSensitive(out),
        stderr: err ? maskSensitive(err) : "",
      });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API listening on port ${PORT}`));
