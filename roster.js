// roster.js
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import "dotenv/config";
import admin from "firebase-admin";
import { google } from "googleapis";
import { exec } from "child_process";

import {
  blhStrToHour,
  hourToTimeStr,
  parseUTCDate,
  calculateET,
  calculateNTFromSTDSTA,
  convertDate,
  parseCrewString,
  parseYearMonthFromEeeDd
} from "./flightTimeUtils.js";

import { generatePerDiemList, savePerDiemCSV, uploadPerDiemFirestore } from "./perdiem.js";

// ------------------- Firebase 초기화 -------------------
console.log("🚀 Firebase 초기화 시작");
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT 없음");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log("✅ Firebase 초기화 완료");

// ------------------- Google Sheets 초기화 -------------------
console.log("🚀 Google Sheets 초기화 시작");
if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
  console.error("❌ GOOGLE_SHEETS_CREDENTIALS 없음");
  process.exit(1);
}
const sheetsCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
if (sheetsCredentials.private_key) sheetsCredentials.private_key = sheetsCredentials.private_key.replace(/\\n/g, "\n");
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });
console.log("✅ Google Sheets 초기화 완료");

// ------------------- UID / Config -------------------
const flutterflowUid = process.env.INPUT_FIREBASE_UID || process.env.FIREBASE_UID;
const firestoreAdminUid = process.env.INPUT_ADMIN_FIREBASE_UID || process.env.ADMIN_FIREBASE_UID;
const firestoreCollection = process.env.INPUT_FIRESTORE_COLLECTION || "roster";
if (!flutterflowUid || !firestoreAdminUid) {
  console.error("❌ Firebase UID 또는 Admin UID 없음");
  process.exit(1);
}
console.log("✅ UID 및 Config 로드 완료");

// ------------------- Puppeteer 브라우저 시작 -------------------
(async () => {
  console.log("🚀 Puppeteer 브라우저 시작");
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox","--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  // ------------------- PDC 로그인 -------------------
  const username = process.env.INPUT_PDC_USERNAME || process.env.PDC_USERNAME;
  const password = process.env.INPUT_PDC_PASSWORD || process.env.PDC_PASSWORD;
  if (!username || !password) {
    console.error("❌ PDC_USERNAME/PASSWORD 없음");
    await browser.close();
    process.exit(1);
  }

  console.log("🚀 PDC 로그인 시도");
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });
  await page.type("#ctl00_Main_userId_edit", username, { delay: 50 });
  await page.type("#ctl00_Main_password_edit", password, { delay: 50 });
  await Promise.all([
    page.click("#ctl00_Main_login_btn"),
    page.waitForNavigation({ waitUntil: "networkidle0" })
  ]);
  console.log("✅ 로그인 성공");

  // ------------------- Roster 메뉴 이동 -------------------
  console.log("🚀 Roster 메뉴 이동");
  const rosterLink = await page.evaluateHandle(() => {
    const links = Array.from(document.querySelectorAll("a"));
    return links.find(a => a.textContent.includes("Roster")) || null;
  });
  if (!rosterLink) { console.error("❌ Roster 링크 없음"); await browser.close(); return; }
  await Promise.all([rosterLink.click(), page.waitForNavigation({ waitUntil: "networkidle0" })]);
  console.log("✅ Roster 메뉴 진입 성공");

  // ------------------- Roster 데이터 추출 -------------------
  console.log("🚀 Roster 데이터 추출");
  await page.waitForSelector("table tr");
  const rosterRaw = await page.evaluate(() => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const tables = Array.from(document.querySelectorAll("table"));
    const tableRows = tables
      .map(table =>
        Array.from(table.querySelectorAll("tr"))
          .map(tr => Array.from(tr.querySelectorAll("th,td")).map(td => normalize(td.innerText)))
      )
      .filter(rows => rows.length > 1);

    const rosterTable = tableRows.find(rows => {
      const firstRow = rows[0] || [];
      return ["Date", "Activity", "From", "To"].every(header =>
        firstRow.some(cell => cell === header || cell.includes(header))
      );
    });

    return rosterTable || tableRows.flat();
  });
  const looksLikeRosterHeader = (row) =>
    ["Date", "Activity", "From", "To"].every(header =>
      row.some(cell => cell === header || cell.includes(header))
    );
  const rosterHeaderIndex = rosterRaw.findIndex(looksLikeRosterHeader);
  const rosterRows = rosterHeaderIndex >= 0 ? rosterRaw.slice(rosterHeaderIndex) : rosterRaw;
  if (rosterRows.length < 2) { console.error("❌ Roster 데이터 비어 있음"); await browser.close(); return; }
  console.log(`✅ Roster 데이터 ${rosterRows.length - 1}행 추출 완료`);

  // ------------------- 헤더 매핑 -------------------
  const headers = ["Date","DC","C/I(L)","C/O(L)","Activity","F","From","STD(L)","STD(Z)","To","STA(L)","STA(Z)","BLH","AcReg","Crew"];
  const siteHeaders = rosterRows[0];
  const headerMap = {};
  const normalizeHeader = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();
  const headerAliases = {
    Date: ["DATE"],
    DC: ["DC"],
    "C/I(L)": ["C/I(L)", "CI(L)", "CIL"],
    "C/O(L)": ["C/O(L)", "CO(L)", "COL"],
    Activity: ["ACTIVITY"],
    F: ["F", "FLT", "FLIGHT", "FLIGHTNO", "FLIGHTNUMBER"],
    From: ["FROM"],
    "STD(L)": ["STD(L)", "STDL"],
    "STD(Z)": ["STD(Z)", "STDZ"],
    To: ["TO"],
    "STA(L)": ["STA(L)", "STAL"],
    "STA(Z)": ["STA(Z)", "STAZ"],
    BLH: ["BLH", "BH"],
    AcReg: ["ACREG", "ACREGISTRATION", "A/CID", "REG"],
    Crew: ["CREW", "CC"],
  };

  headers.forEach(h => {
    const aliases = headerAliases[h] || [h];
    const idx = siteHeaders.findIndex(col => aliases.includes(normalizeHeader(col)));
    if(idx >= 0) headerMap[h] = idx;
  });
  console.log("✅ 헤더 매핑 완료");

  const dateIdx = headers.indexOf("Date");
  const dcIdx = headers.indexOf("DC");
  const activityIdx = headers.indexOf("Activity");
  const flightIdx = headers.indexOf("F");
  const fromIdx = headers.indexOf("From");
  const toIdx = headers.indexOf("To");

  // ------------------- 행 데이터 정리 -------------------
  const isFlightNumber = (value) => /^YP\d+/i.test(String(value || "").trim());
  const isRosterDataRow = (row) => {
    const normalized = row.map(cell => String(cell || "").trim());
    if (normalized.every(cell => !cell)) return false;
    if (normalizeHeader(normalized[dateIdx]) === "DATE") return false;
    if (normalizeHeader(normalized[activityIdx]) === "ACTIVITY") return false;
    return Boolean(normalized[activityIdx] && (normalized[fromIdx] || normalized[toIdx]));
  };

  let values = rosterRows.slice(1)
    .map(row => headers.map(h => {
      if(h==="AcReg") return (headerMap[h] !== undefined ? row[headerMap[h]] : row[18]) || "";
      if(h==="Crew") return (headerMap[h] !== undefined ? row[headerMap[h]] : row[22]) || "";
      const idx = headerMap[h]; 
      return idx!==undefined ? row[idx]||"" : "";
    }))
    .map(row => {
      if (!row[flightIdx] && isFlightNumber(row[activityIdx])) row[flightIdx] = row[activityIdx];
      return row;
    })
    .filter(isRosterDataRow);

  // ------------------- CSV/JSON 저장 전 중복 제거 (기존 Map 로직 유지) -------------------
  console.log("🚀 CSV/JSON 저장 전 중복 제거");
  const normalizeDate = (raw) => convertDate(raw) || (raw || "").replace(/[.\s]/g, "");

  const mapByKey = new Map();
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const key = `${normalizeDate(row[dateIdx])}||${row[dcIdx]}||${row[flightIdx]}||${row[fromIdx]}||${row[toIdx]}`;
    mapByKey.set(key, row); // 나중 항목 덮어쓰기 -> 최신 유지
  }
  const dedupedRows = Array.from(mapByKey.values());
  values = [headers, ...dedupedRows];
  console.log("✅ CSV/JSON 저장 전 중복 제거 완료. 최종 행 수:", values.length - 1);

  await browser.close();

  // ------------------- JSON/CSV 파일 저장 -------------------
  console.log("🚀 JSON/CSV 저장");
  const publicDir = path.join(process.cwd(),"public");
  if(!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir,"roster.json"), JSON.stringify({values}, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(publicDir,"roster.csv"),
    values.map(row => row.map(col => `"${(col||"").replace(/"/g,'""')}"`).join(",")).join("\n"),
    "utf-8"
  );
  console.log("✅ JSON/CSV 저장 완료");

  // ------------------- PerDiem 처리 -------------------
  console.log("🚀 PerDiem 처리 시작");
  const perdiemList = await generatePerDiemList(path.join(publicDir,"roster.json"), flutterflowUid);
  const flightPerDiemList = perdiemList.filter(p => p.Destination && p.RI && p.RO);
  savePerDiemCSV(flightPerDiemList, path.join(publicDir,"perdiem.csv"));
  await uploadPerDiemFirestore(flightPerDiemList, flutterflowUid);
  console.log("✅ PerDiem 처리 완료");

  // ------------------- Roster Firestore 업로드 -------------------
  console.log("🚀 Roster Firestore 업로드 시작");

  const headerMapFirestore = { "C/I(L)":"CIL", "C/O(L)":"COL", "STD(L)":"STDL", "STD(Z)":"STDZ", "STA(L)":"STAL", "STA(Z)":"STAZ" };
  const QUICK_DESTS = ["NRT","HKG","DAC"];

  function resolveDateRaw(i, values, docData) {
    if (docData.Date && docData.Date.trim()) return docData.Date;
    const prevRow = i > 1 ? values[i - 1] : null;
    if (prevRow && QUICK_DESTS.includes(docData.From) && prevRow[9] == docData.From && prevRow[6] == "ICN")
      return prevRow[0];
    const prevDate = prevRow ? prevRow[0] : "";
    const nextDate = i < values.length - 1 ? values[i + 1][0] : "";
    return prevDate || nextDate || "";
  }

  function buildDocData(row, headers, i, values) {
    const docData = {};
    headers.forEach((h, idx) => {
      docData[h] = row[idx] || "";
      docData[headerMapFirestore[h] || h] = row[idx] || "";
    });
    docData.DateRaw = resolveDateRaw(i, values, docData);
    docData.Date = convertDate(docData.DateRaw);
    docData.owner = firestoreAdminUid || "";
    docData.pdc_user_name = username || "";
    docData.email = process.env.USER_ID || "";
    if (!docData.Activity || docData.Activity.trim() === "") return null;
    docData.ET = calculateET(docData.BLH);
    docData.NT = docData.From !== docData.To
      ? calculateNTFromSTDSTA(docData.STDZ, docData.STAZ, new Date(docData.Date))
      : "00:00";
    docData.CrewArray = parseCrewString(docData.Crew);
    const { Year, Month } = parseYearMonthFromEeeDd(docData.DateRaw);
    docData.Year = Year;
    docData.Month = Month;
    Object.keys(docData).forEach(k => {
      if (docData[k] === undefined) delete docData[k];
    });
    return docData;
  }

  async function uploadDoc(db, collectionName, docData, i) {
    // Firestore 업로드 시 중복 제거 기준: Date/DC/F/From/To
    const querySnapshot = await db.collection(collectionName)
      .where("Date", "==", docData.Date)
      .where("DC", "==", docData.DC)
      .where("F", "==", docData.F)
      .where("From", "==", docData.From)
      .where("To", "==", docData.To)
      .get();

    if (!querySnapshot.empty) {
      for (const d of querySnapshot.docs) {
        await db.collection(collectionName).doc(d.id).delete();
      }
    }

    const newDocRef = await db.collection(collectionName).add(docData);
    console.log(
      `✅ ${i}행 업로드 완료 (중복 기준: Date/DC/F/From/To): ${newDocRef.id}, NT=${docData.NT}, ET=${docData.ET}, CrewCount=${docData.CrewArray.length}, Year=${docData.Year}, Month=${docData.Month}`
    );
  }

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const docData = buildDocData(row, headers, i, values);
    if (!docData) continue;
    await uploadDoc(db, firestoreCollection, docData, i);
  }

  console.log("✅ Roster Firestore 업로드 완료");

  // ------------------- Google Sheets 업로드 -------------------
  console.log("🚀 Google Sheets 업로드 시작");
  const spreadsheetId="1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
  const sheetName="Roster1";
  const sheetValues = values.map((row,idx)=>{
    if(idx===0) return row.slice(0,15); 
    const newRow=[...row.slice(0,15)];
    newRow[0] = convertDate(row[0]);
    return newRow;
  });

  try {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range:`${sheetName}!A1`,
      valueInputOption:"RAW",
      requestBody:{values:sheetValues}
    });
    console.log("✅ Google Sheets 업로드 완료");
  } catch(err) {
    console.error("❌ Google Sheets 업로드 실패:",err);
  }

  // ------------------- Google Calendar 업로드 -------------------
  console.log("🚀 Google Calendar 업로드 시작 (gcal.js)");
  const gcalPath = path.join(process.cwd(),"gcal.js");
  exec(`node "${gcalPath}"`, (error, stdout, stderr) => {
    if(error){
      console.error("❌ gcal.js 실행 실패:", error.message);
      return;
    }
    if(stderr) console.error("stderr:", stderr);
    console.log(stdout);
    console.log("✅ Google Calendar 처리 완료");
  });

})();
