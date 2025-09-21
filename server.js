import express from "express";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

app.post("/runRoster", async (req, res) => {
  try {
    const { username, password, firebaseUid, adminFirebaseUid } = req.body;

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
        res.status(500).json({ success: false, error: error || "Unknown error" });
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
