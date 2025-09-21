import express from "express";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

app.post("/runRoster", async (req, res) => {
  try {
    const { username, password, firebaseUid, adminFirebaseUid } = req.body;

    // child process 실행 시 env 우선 전달
    const env = {
      ...process.env,
      INPUT_PDC_USERNAME: username || "",
      INPUT_PDC_PASSWORD: password || "",
      INPUT_FIREBASE_UID: firebaseUid || "",
      INPUT_ADMIN_FIREBASE_UID: adminFirebaseUid || "",
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
        res
          .status(500)
          .json({ success: false, error: error || "Unknown error" });
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(3000, () => console.log("🚀 Server running on port 3000"));
