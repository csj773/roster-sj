import express from "express";
import { spawn } from "child_process";
import "dotenv/config";

const app = express();
app.use(express.json());

// ------------------- POST /runRoster -------------------
app.post("/runRoster", async (req, res) => {
  try {
    const { username, password, firebaseUid, adminFirebaseUid } = req.body;

    // child process 실행 시 env 우선 전달
    const env = {
      ...process.env,
      INPUT_PDC_USERNAME: username || process.env.PDC_USERNAME || "",
      INPUT_PDC_PASSWORD: password || process.env.PDC_PASSWORD || "",
      INPUT_FIREBASE_UID: firebaseUid || process.env.FLUTTERFLOW_UID || "",
      INPUT_ADMIN_FIREBASE_UID: adminFirebaseUid || process.env.FIRESTORE_ADMIN_UID || "",
    };

    const child = spawn("node", ["-r", "dotenv/config", "roster.js"], { env });

    let output = "";
    let error = "";

    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));

    child.on("close", (code) => {
      if (code === 0) {
        res.json({ success: true, log: output });
      } else {
        res.status(500).json({ success: false, error: error || "Unknown error" });
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// ------------------- 서버 실행 -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
