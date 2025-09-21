import express from "express";
import puppeteer from "puppeteer-core"; // 서버리스 환경용
import chrome from "chrome-aws-lambda"; // chromium 경로 제공
import admin from "firebase-admin";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || "change_me";

// 정규식 escape
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// POST /runRoster
app.post("/runRoster", async (req, res) => {
  try {
    const auth = req.headers["x-api-key"];
    if (!auth || auth !== API_KEY)
      return res.status(401).json({ error: "Unauthorized" });

    // FlutterFlow POST > env > fallback
    const username = req.body.username || process.env.INPUT_PDC_USERNAME;
    const password = req.body.password || process.env.INPUT_PDC_PASSWORD;
    const flutterflowUid = req.body.firebaseUid || process.env.INPUT_FIREBASE_UID;
    const firestoreAdminUid = req.body.adminFirebaseUid || process.env.INPUT_ADMIN_FIREBASE_UID;
    const firebaseServiceAccount = req.body.firebaseServiceAccount || process.env.FIREBASE_SERVICE_ACCOUNT;
    const googleSheetsCredentials = req.body.googleSheetsCredentials || process.env.GOOGLE_SHEETS_CREDENTIALS;

    if (!username || !password)
      return res.status(400).json({ error: "PDC 계정 필요" });
    if (!flutterflowUid || !firestoreAdminUid)
      return res.status(400).json({ error: "FlutterFlow UID / Admin UID 필요" });
    if (!firebaseServiceAccount || !googleSheetsCredentials)
      return res.status(400).json({ error: "Firebase/Google Sheets credentials 필요" });

    // ------------------- Firebase 초기화 -------------------
    const serviceAccount = typeof firebaseServiceAccount === "string"
      ? JSON.parse(firebaseServiceAccount)
      : firebaseServiceAccount;

    if (serviceAccount.private_key)
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

    if (!admin.apps.length)
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    const db = admin.firestore();

    // ------------------- Google Sheets 초기화 -------------------
    const sheetsCreds = typeof googleSheetsCredentials === "string"
      ? JSON.parse(googleSheetsCredentials)
      : googleSheetsCredentials;

    if (sheetsCreds.private_key)
      sheetsCreds.private_key = sheetsCreds.private_key.replace(/\\n/g, "\n");

    const sheetsAuth = new google.auth.GoogleAuth({
      credentials: sheetsCreds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });

    // ------------------- Puppeteer 실행 -------------------
    const browser = await puppeteer.launch({
      args: chrome.args,
      executablePath: await chrome.executablePath,
      headless: true,
    });
    const page = await browser.newPage();

    console.log(`👉 로그인 시도 중... [uid=${flutterflowUid}]`);
    await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });
    await page.type("#ctl00_Main_userId_edit", username, { delay: 50 });
    await page.type("#ctl00_Main_password_edit", password, { delay: 50 });
    await Promise.all([
      page.click("#ctl00_Main_login_btn"),
      page.waitForNavigation({ waitUntil: "networkidle0" }),
    ]);
    console.log("✅ 로그인 성공");

    // ------------------- 이후 roster.js 내용 그대로 사용 -------------------
    // Firestore 업로드, Google Sheets 업로드, CSV/JSON 저장 등
    // 기존 roster.js 내용을 그대로 이곳에 넣으면 됨

    await browser.close();
    res.json({ message: "Roster 작업 완료" });

  } catch (error) {
    console.error("❌ Roster 실행 실패:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
