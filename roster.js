// roster.js
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import "dotenv/config";
import admin from "firebase-admin";
import { google } from "googleapis";
import { blhStrToHour, hourToTimeStr, parseUTCDate, calculateET, calculateNT, convertDate } from "./flightTimeUtils.js";

// ------------------- Firebase 초기화 -------------------
console.log("🚀 Firebase 초기화 시작");
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("❌ FIREBASE_SERVICE_ACCOUNT 없음"); process.exit(1); }
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log("✅ Firebase 초기화 완료");

// ------------------- Google Sheets 초기화 -------------------
console.log("🚀 Google Sheets 초기화 시작");
if (!process.env.GOOGLE_SHEETS_CREDENTIALS) { console.error("❌ GOOGLE_SHEETS_CREDENTIALS 없음"); process.exit(1); }
const sheetsCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
if (sheetsCredentials.private_key) sheetsCredentials.private_key = sheetsCredentials.private_key.replace(/\\n/g, "\n");
const sheetsAuth = new google.auth.GoogleAuth({ credentials: sheetsCredentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });
console.log("✅ Google Sheets 초기화 완료");

// ------------------- UID / Config -------------------
const flutterflowUid = process.env.INPUT_FIREBASE_UID || process.env.FIREBASE_UID;
const firestoreAdminUid = process.env.INPUT_ADMIN_FIREBASE_UID || process.env.ADMIN_FIREBASE_UID;
const firestoreCollection = process.env.INPUT_FIRESTORE_COLLECTION || "roster";
if (!flutterflowUid || !firestoreAdminUid) { console.error("❌ Firebase UID 또는 Admin UID 없음"); process.exit(1); }
console.log("✅ UID 및 Config 로드 완료");

// ------------------- Puppeteer 시작 -------------------
(async () => {
  console.log("🚀 Puppeteer 브라우저 시작");
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox","--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  const username = process.env.INPUT_PDC_USERNAME || process.env.PDC_USERNAME;
  const password = process.env.INPUT_PDC_PASSWORD || process.env.PDC_PASSWORD;
  if (!username || !password) { console.error("❌ PDC_USERNAME/PASSWORD 없음"); await browser.close(); process.exit(1); }

  console.log("🚀 PDC 로그인 시도");
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });
  await page.type("#ctl00_Main_userId_edit", username, { delay: 50 });
  await page.type("#ctl00_Main_password_edit", password, { delay: 50 });
  await Promise.all([page.click("#ctl00_Main_login_btn"), page.waitForNavigation({ waitUntil: "networkidle0" })]);
  console.log("✅ 로그인 성공");

  // Roster 메뉴
  console.log("🚀 Roster 메뉴 이동");
  const rosterLink = await page.evaluateHandle(() => {
    const links = Array.from(document.querySelectorAll("a"));
    return links.find(a => a.textContent.includes("Roster")) || null;
  });
  if (!rosterLink) { console.error("❌ Roster 링크 없음"); await browser.close(); return; }
  await Promise.all([rosterLink.click(), page.waitForNavigation({ waitUntil: "networkidle0" })]);
  console.log("✅ Roster 메뉴 진입 성공");

  // Roster 데이터 추출
  console.log("🚀 Roster 데이터 추출");
  await page.waitForSelector("table tr");
  const rosterRaw = await page.evaluate(() =>
    Array.from(document.querySelectorAll("table tr"))
      .map(tr => Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim()))
  );
  if (rosterRaw.length < 2) { console.error("❌ Roster 데이터 비어 있음"); await browser.close(); return; }
  console.log(`✅ Roster 데이터 ${rosterRaw.length - 1}행 추출 완료`);

  const headers = ["Date","DC","C/I(L)","C/O(L)","Activity","F","From","STD(L)","STD(Z)","To","STA(L)","STA(Z)","BLH","AcReg","Crew"];
  const siteHeaders = rosterRaw[0];
  const headerMap = {};
  headers.forEach(h => { const idx = siteHeaders.findIndex(col => col.includes(h)); if(idx>=0) headerMap[h]=idx; });
  console.log("✅ 헤더 매핑 완료");

  let values = rosterRaw.slice(1).map(row => headers.map(h=>{
    if(h==="AcReg") return row[18]||""; 
    if(h==="Crew") return row[22]||""; 
    const idx = headerMap[h]; return idx!==undefined ? row[idx]||"" : "";
  }));

  // 중복 제거
  console.log("🚀 중복 제거");
  const seen = new Set();
  values = values.filter(row=>{ const key=row.join("||"); if(seen.has(key)) return false; seen.add(key); return true; });
  values.unshift(headers);
  console.log("✅ 중복 제거 완료. 최종 행 수:", values.length - 1);

  // 파일 저장
  console.log("🚀 JSON/CSV 저장");
  const publicDir = path.join(process.cwd(),"public");
  if(!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir,"roster.json"),JSON.stringify({values},null,2),"utf-8");
  fs.writeFileSync(path.join(publicDir,"roster.csv"),values.map(row=>row.map(col=>`"${(col||"").replace(/"/g,'""')}"`).join(",")).join("\n"),"utf-8");
  console.log("✅ JSON/CSV 저장 완료");
  await browser.close();

 // Firestore 업로드
console.log("🚀 Firestore 업로드 시작");
const headerMapFirestore = {
  "C/I(L)": "CIL",
  "C/O(L)": "COL",
  "STD(L)": "STDL",
  "STD(Z)": "STDZ",
  "STA(L)": "STAL",
  "STA(Z)": "STAZ",
};

for (let i = 1; i < values.length; i++) {
  const row = values[i];
  const docData = {};
  headers.forEach((h, idx) => {
    docData[headerMapFirestore[h] || h] = row[idx] || "";
  });
  docData.userId = flutterflowUid;
  docData.adminId = firestoreAdminUid;
  docData.pdc_user_name = username;

  if (!docData.Activity || docData.Activity.trim() === "") continue;

  // ET 계산
  docData.ET = calculateET(docData.BLH);

  // NT 계산 (STD(Z), STA(Z) HHMM+1/-1 처리 포함)
  if (docData.From !== docData.To) {
    const flightDate = new Date(docData.Date);
    docData.NT = calculateNT(docData.STDZ, docData.STAZ, flightDate);
  } else {
    docData.NT = "00:00";
  }

  // 중복 제거 후 신규 저장
  const querySnapshot = await db
    .collection(firestoreCollection)
    .where("Date", "==", docData.Date)
    .where("DC", "==", docData.DC)
    .where("F", "==", docData.F)
    .where("From", "==", docData.From)
    .where("To", "==", docData.To)
    .where("AcReg", "==", docData.AcReg)
    .where("Crew", "==", docData.Crew)
    .where("userId", "==", flutterflowUid)
    .get();

  if (!querySnapshot.empty) {
    // 중복 문서 삭제 후 신규 저장
    for (const doc of querySnapshot.docs) {
      await db.collection(firestoreCollection).doc(doc.id).delete();
    }
  }

  const newDocRef = await db.collection(firestoreCollection).add(docData);
  console.log(`✅ ${i}행 신규 업로드 완료: ${newDocRef.id}, NT=${docData.NT}, ET=${docData.ET}`);
}
 

  // ------------------- Google Sheets 업로드 (Crew까지만) -------------------
  console.log("🚀 Google Sheets 업로드 시작");
  const spreadsheetId="1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
  const sheetName="Roster1";
  const sheetValues = values.map((row,idx)=>{
    if(idx===0) return row.slice(0,15); // Crew까지만
    const newRow=[...row.slice(0,15)];
    newRow[0] = convertDate(row[0]);
    return newRow;
  });

  try{
    await sheetsApi.spreadsheets.values.update({spreadsheetId, range:`${sheetName}!A1`, valueInputOption:"RAW", requestBody:{values:sheetValues}});
    console.log("✅ Google Sheets 업로드 완료");
  }catch(err){ console.error("❌ Google Sheets 업로드 실패:",err); }

})();
