import express from "express";
import { spawn } from "child_process";
import "dotenv/config";

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || "change_me";

// 정규식 escape 함수
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

app.post("/runRoster", async (req, res) => {
  try {
    const auth = req.headers["x-api-key"];
    if (!auth || auth !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // body > env > fallback 순서
    const username = req.body.username || process.env.INPUT_PDC_USERNAME;
    const password = req.body.password || process.env.INPUT_PDC_PASSWORD;
    const firebaseUid = req.body.firebaseUid || process.env.INPUT_FIREBASE_UID;
    const adminFirebaseUid = req.body.adminFirebaseUid || process.env.INPUT_ADMIN_FIREBASE_UID;

    if (!username || !password) {
      return res.status(400).json({ error: "PDC 계정(username/password)이 입력되지 않았습니다." });
    }
    if (!firebaseUid || !adminFirebaseUid) {
      return res.status(400).json({ error: "FlutterFlow UID 또는 Admin UID가 입력되지 않았습니다." });
    }

    // roster.js 실행
    const env = {
      ...process.env,
      INPUT_PDC_USERNAME: username,
      INPUT_PDC_PASSWORD: password,
      INPUT_FIREBASE_UID: firebaseUid,
      INPUT_ADMIN_FIREBASE_UID: adminFirebaseUid,
    };

    const child = spawn("node", ["./roster.js"], { env, stdio: "pipe" });

    let stdout = "", stderr = "";

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text); // 콘솔에도 실시간 출력
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text); // 콘솔에도 실시간 출력
    });

    child.on("close", (code) => {
      res.json({
        exitCode: code,
        stdout: stdout.replace(new RegExp(escapeRegex(username), "g"), "[REDACTED]"),
        stderr: stderr || "",
      });
    });

  } catch (error) {
    console.error("❌ 서버 실행 에러:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
