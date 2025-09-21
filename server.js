import express from "express";
import { spawn } from "child_process";
import "dotenv/config";

const app = express();
app.use(express.json());

app.post("/runRoster", (req, res) => {
  const { username, password, firebaseUid, adminFirebaseUid } = req.body;

  const env = {
    ...process.env,
    INPUT_PDC_USERNAME: username || process.env.PDC_USERNAME || "",
    INPUT_PDC_PASSWORD: password || process.env.PDC_PASSWORD || "",
    INPUT_FIREBASE_UID: firebaseUid || process.env.FLUTTERFLOW_UID || "",
    INPUT_ADMIN_FIREBASE_UID: adminFirebaseUid || process.env.FIRESTORE_ADMIN_UID || "",
    FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT || "",
    GOOGLE_SHEETS_CREDENTIALS: process.env.GOOGLE_SHEETS_CREDENTIALS || "",
  };

  const child = spawn("node", ["-r", "dotenv/config", "roster.js"], { env });

  let output = "", error = "";

  child.stdout.on("data", (data) => output += data.toString());
  child.stderr.on("data", (data) => error += data.toString());

  child.on("error", (err) => {
    console.error("Child process error:", err);
    res.status(500).json({ success: false, error: err.message });
  });

  child.on("close", (code) => {
    if (code === 0) res.json({ success: true, log: output });
    else res.status(500).json({ success: false, error: error || "Unknown error" });
  });
});

app.listen(3000, () => console.log("🚀 Server running on port 3000"));
