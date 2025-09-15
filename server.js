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

    // FlutterFlow에서 전달된 값 우선, 없으면 환경변수 사용
    const username =
      req.body.username ||
      process.env.INPUT_PDC_USERNAME ||
      process.env.PDC_USERNAME;

    const password =
      req.body.password ||
      process.env.INPUT_PDC_PASSWORD ||
      process.env.PDC_PASSWORD;

    const firebaseUid =
      req.body.firebaseUid ||
      process.env.INPUT_FIREBASE_UID ||
      process.env.FIREBASE_UID;

    const adminFirebaseUid =
      req.body.adminFirebaseUid ||
      process.env.INPUT_ADMIN_FIREBASE_UID ||
      process.env.ADMIN_FIREBASE_UID;

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "PDC 계정(username/password)이 입력되지 않았습니다." });
    }

    if (!firebaseUid || !adminFirebaseUid) {
      return res
        .status(400)
        .json({ error: "Firebase UID(userId) 또는 Admin UID(adminId)가 입력되지 않았습니다." });
    }

    // roster.js 실행 시 환경변수 전달
    const env = {
      ...process.env,
      INPUT_PDC_USERNAME: username,
      INPUT_PDC_PASSWORD: password,
      INPUT_FIREBASE_UID: firebaseUid,
      INPUT_ADMIN_FIREBASE_UID: adminFirebaseUid,
    };

    const child = spawn("node", ["./roster.js"], { env });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("close", (code) => {
      res.json({
        exitCode: code,
        stdout: out.replace(new RegExp(escapeRegex(username), "g"), "[REDACTED]"),
        stderr: err || "",
      });
    });
  } catch (e) {
    console.error("❌ 서버 실행 에러:", e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
