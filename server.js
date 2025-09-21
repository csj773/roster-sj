import express from "express";
import puppeteer from "puppeteer-core"; // Render 환경에 맞춰 puppeteer-core 사용
import chrome from "chrome-aws-lambda"; // Render, AWS Lambda 등에서 chromium 경로 제공
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || "change_me";

// Firebase 초기화
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

// Google Sheets 초기화
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

// 정규식 escape
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// POST /runRoster
app.post("/runRoster", async (req, res) => {
  try {
    const auth = req.headers["x-api-key"];
    if (!auth || auth !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // FlutterFlow POST > env > fallback
    const username = req.body.username || process.env.INPUT_PDC_USERNAME;
    const password = req.body.password || process.env.INPUT_PDC_PASSWORD;
    const flutterflowUid = req.body.firebaseUid || process.env.INPUT_FIREBASE_UID;
    const firestoreAdminUid = req.body.adminFirebaseUid || process.env.INPUT_ADMIN_FIREBASE_UID;

    if (!username || !password)
      return res.status(400).json({ error: "PDC 계정(username/password) 필요" });
    if (!flutterflowUid || !firestoreAdminUid)
      return res.status(400).json({ error: "FlutterFlow UID / Admin UID 필요" });

    // Puppeteer 실행
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

    // 이후 roster 추출 + Firestore / Sheets 업로드 코드 동일
    // --- 생략: 기존 roster.js 내용 그대로 사용 가능 ---
    
    await browser.close();
    res.json({ message: "Roster 작업 완료" });

  } catch (error) {
    console.error("❌ Roster 실행 실패:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
