import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || "change_me";

// ------------------- Firebase 초기화 -------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (serviceAccount.private_key)
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
if (!admin.apps.length)
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ------------------- Google Sheets 초기화 -------------------
if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
  console.error("❌ GOOGLE_SHEETS_CREDENTIALS 환경변수가 없습니다.");
  process.exit(1);
}
const sheetsCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
if (sheetsCredentials.private_key)
  sheetsCredentials.private_key = sheetsCredentials.private_key.replace(/\\n/g, "\n");
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });

// ------------------- Express POST /runRoster -------------------
app.post("/runRoster", async (req, res) => {
  try {
    // API Key 인증
    const auth = req.headers["x-api-key"];
    if (!auth || auth !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // FlutterFlow POST > env fallback
    const username = req.body.username || process.env.PDC_USERNAME;
    const password = req.body.password || process.env.PDC_PASSWORD;
    const flutterflowUid = req.body.firebaseUid || process.env.FLUTTERFLOW_UID;
    const firestoreAdminUid = req.body.adminFirebaseUid || process.env.FIRESTORE_ADMIN_UID;

    if (!username || !password)
      return res.status(400).json({ error: "PDC 계정 필요" });
    if (!flutterflowUid || !firestoreAdminUid)
      return res.status(400).json({ error: "FlutterFlow UID / Admin UID 필요" });

    // Puppeteer 실행
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
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

    // ------------------- 기존 roster.js 내용 수행 -------------------
    // 1. Roster 테이블 추출
    // 2. JSON / CSV 저장
    // 3. Firestore 업로드 (userId/flutterflowUid, adminId/firestoreAdminUid 포함)
    // 4. Google Sheets 업로드
    // FlutterFlow에서 보내온 값 사용 가능, 없으면 env fallback

    await browser.close();
    res.json({ message: "Roster 작업 완료" });
  } catch (error) {
    console.error("❌ Roster 실행 실패:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
