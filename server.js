import express from "express";
import { spawn } from "child_process";
import "dotenv/config";

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || "change_me";

// ------------------- POST /runRoster -------------------
app.post("/runRoster", async (req, res) => {
  try {
    const auth = req.headers["x-api-key"];
    if (!auth || auth !== API_KEY) return res.status(401).json({ error: "Unauthorized" });

    const { username, password, firebaseUid } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });

    const env = {
      ...process.env,
      INPUT_PDC_USERNAME: username,
      INPUT_PDC_PASSWORD: password,
      FIREBASE_UID: firebaseUid || process.env.FIREBASE_UID,
    };

    const child = spawn("node", ["./roster.js"], { env });

    let out = "";
    let err = "";

    // stdout / stderr 수집
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    // 종료 시 JSON으로 반환
    child.on("close", (code) => {
      res.json({
        exitCode: code,
        stdout: out.replace(new RegExp(username, "g"), "[REDACTED]"),
        stderr: err || "",
      });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------- 서버 실행 -------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

