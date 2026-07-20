import fs from "fs";
import path from "path";
import csv from "csv-parser";
import admin from "firebase-admin";
import { google } from "googleapis";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

import {
  calculateET,
  calculateNTFromSTDSTA,
  parseCrewString,
} from "./flightTimeUtils.js";

dayjs.extend(customParseFormat);

const ROSTER_HEADERS = [
  "Date",
  "DC",
  "C/I(L)",
  "C/O(L)",
  "Activity",
  "F",
  "From",
  "STD(L)",
  "STD(Z)",
  "To",
  "STA(L)",
  "STA(Z)",
  "BLH",
  "AcReg",
  "Crew",
];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HEADER_MAP_FIRESTORE = {
  "C/I(L)": "CIL",
  "C/O(L)": "COL",
  "STD(L)": "STDL",
  "STD(Z)": "STDZ",
  "STA(L)": "STAL",
  "STA(Z)": "STAZ",
};

function requiredJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    console.error(`❌ ${name} Secret이 없습니다.`);
    process.exit(1);
  }
  const parsed = JSON.parse(raw);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

const serviceAccount = requiredJsonEnv("FIREBASE_SERVICE_ACCOUNT");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const firestoreCollection = process.env.INPUT_FIRESTORE_COLLECTION || process.env.FIRESTORE_COLLECTION || "roster";
const owner = process.env.INPUT_ADMIN_FIREBASE_UID || process.env.FIRESTORE_ADMIN_UID || process.env.FIREBASE_UID || "manual_upload";
const userEmail = process.env.USER_ID || "";
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
const sheetName = process.env.ROSTER_SHEET_NAME || "Roster1";

const sheetsCredentials = requiredJsonEnv("GOOGLE_SHEETS_CREDENTIALS");
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });

function findCsvFile(filename = "my_flightlog.csv", dir = process.cwd()) {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (f === filename) return full;
    if (fs.statSync(full).isDirectory()) {
      const nested = findCsvFile(filename, full);
      if (nested) return nested;
    }
  }
  return null;
}

function normalizeDateText(csvDateStr) {
  const raw = String(csvDateStr || "").trim();
  if (!raw) return "";

  const normalized = raw
    .replace(/(\d+)\.(\w+)\.(\d{2,4})/, "$1 $2 $3")
    .replace(/\s+/g, " ")
    .trim();

  const parsed = dayjs(normalized, ["D MMM YY", "DD MMM YY", "D MMM YYYY", "DD MMM YYYY"], "en", true);
  if (parsed.isValid()) return parsed.format("YYYY.MM.DD");

  const dotMatch = raw.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (dotMatch) {
    return `${dotMatch[1]}.${String(dotMatch[2]).padStart(2, "0")}.${String(dotMatch[3]).padStart(2, "0")}`;
  }

  console.warn(`⚠️ 날짜 파싱 실패: ${csvDateStr}`);
  return raw;
}

function dateObjectFromDots(dateText) {
  const match = String(dateText || "").match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (!match) return new Date();
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function yearMonthFromDate(dateText) {
  const match = String(dateText || "").match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (!match) return { Year: "", Month: "" };
  return { Year: match[1], Month: MONTH_NAMES[Number(match[2]) - 1] || "" };
}

function getValue(row, keys, fallback = "") {
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return fallback;
}

function csvRowToRosterRow(row) {
  const activity = getValue(row, ["Activity", "FLT", "F"]);
  return [
    normalizeDateText(getValue(row, ["Date"])),
    getValue(row, ["DC"]),
    getValue(row, ["CI", "C/I(L)", "CIL", "StartCI"]),
    getValue(row, ["CO", "C/O(L)", "COL", "FinishCO"]),
    activity,
    getValue(row, ["F", "FLT"], activity),
    getValue(row, ["From", "FROM"]),
    getValue(row, ["StartL", "STD(L)", "STDL"]),
    getValue(row, ["StartZ", "STD(Z)", "STDZ"]),
    getValue(row, ["To", "TO"]),
    getValue(row, ["FinishL", "STA(L)", "STAL"]),
    getValue(row, ["FinishZ", "STA(Z)", "STAZ"]),
    getValue(row, ["BH", "BLH", "BLK"], "00:00"),
    getValue(row, ["AcReg", "A/C ID", "REG"]),
    getValue(row, ["Crew"]),
  ];
}

function buildDocData(rosterRow) {
  const docData = {};
  ROSTER_HEADERS.forEach((header, index) => {
    const value = rosterRow[index] || "";
    docData[header] = value;
    docData[HEADER_MAP_FIRESTORE[header] || header] = value;
  });

  docData.DateRaw = docData.Date;
  docData.owner = owner;
  docData.uid = owner;
  docData.pdc_user_name = "csv_upload";
  docData.email = userEmail;
  docData.ET = calculateET(docData.BLH);
  docData.NT = docData.From !== docData.To
    ? calculateNTFromSTDSTA(docData.STDZ, docData.STAZ, dateObjectFromDots(docData.Date), docData.BLH)
    : "00:00";
  docData.CrewArray = parseCrewString(docData.Crew);
  const { Year, Month } = yearMonthFromDate(docData.Date);
  docData.Year = Year;
  docData.Month = Month;
  docData.uploadedAt = admin.firestore.FieldValue.serverTimestamp();

  Object.keys(docData).forEach((key) => {
    if (docData[key] === undefined) delete docData[key];
  });
  return docData;
}

function safeDocIdPart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "blank";
}

function buildRosterDocId(docData) {
  return [
    "csv",
    docData.owner,
    docData.Date,
    docData.DC,
    docData.Activity,
    docData.From,
    docData.To,
  ].map(safeDocIdPart).join("_");
}

async function collectDuplicateRosterDocs(docData) {
  const duplicateRefs = new Map();
  const queries = [
    db.collection(firestoreCollection)
      .where("owner", "==", docData.owner)
      .where("Date", "==", docData.Date)
      .where("Activity", "==", docData.Activity)
      .where("From", "==", docData.From)
      .where("To", "==", docData.To),
    db.collection(firestoreCollection)
      .where("owner", "==", docData.owner)
      .where("Date", "==", docData.Date)
      .where("DC", "==", docData.DC)
      .where("Activity", "==", docData.Activity)
      .where("From", "==", docData.From)
      .where("To", "==", docData.To),
    db.collection(firestoreCollection)
      .where("owner", "==", docData.owner)
      .where("Date", "==", docData.Date)
      .where("F", "==", docData.F)
      .where("From", "==", docData.From)
      .where("To", "==", docData.To),
  ];

  for (const query of queries) {
    const snapshot = await query.get();
    for (const duplicate of snapshot.docs) {
      duplicateRefs.set(duplicate.id, duplicate.ref);
    }
  }

  return [...duplicateRefs.values()];
}

async function uploadRosterDoc(docData, index) {
  const docId = buildRosterDocId(docData);
  const duplicateRefs = await collectDuplicateRosterDocs(docData);

  for (const duplicateRef of duplicateRefs) {
    if (duplicateRef.id !== docId) await duplicateRef.delete();
  }

  await db.collection(firestoreCollection).doc(docId).set(docData);
  console.log(
    `✅ ${index}행 roster 저장 완료: ${docId}, Date=${docData.Date}, Activity=${docData.Activity}, 중복삭제=${duplicateRefs.length}, NT=${docData.NT}, ET=${docData.ET}`
  );
}

async function updateRosterSheet(values) {
  console.log(`🚀 Google Sheets ${sheetName} 초기화 및 업로드 시작: ${spreadsheetId}`);

  await sheetsApi.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A:O`,
  });

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values },
  });
  console.log(`✅ Google Sheets ${sheetName} 업로드 완료 (${values.length - 1}행)`);
}

async function readCsvRows(csvFile) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(csvFile)
      .pipe(csv())
      .on("data", (data) => rows.push(data))
      .on("error", reject)
      .on("end", () => resolve(rows));
  });
}

async function main() {
  const csvFile = process.argv[2] || findCsvFile();
  if (!csvFile) {
    console.error("❌ my_flightlog.csv 파일을 찾을 수 없습니다.");
    process.exit(1);
  }
  console.log(`📄 CSV 파일 발견: ${csvFile}`);

  const csvRows = await readCsvRows(csvFile);
  if (!csvRows.length) {
    console.error("❌ CSV에 데이터가 없습니다.");
    process.exit(1);
  }
  console.log(`📄 ${csvRows.length}개 행 로드 완료`);

  const rosterRows = csvRows
    .map(csvRowToRosterRow)
    .filter((row) => row[4] && row[6] && row[9]);

  const mapByKey = new Map();
  for (const row of rosterRows) {
    const key = `${row[0]}||${row[1]}||${row[4]}||${row[6]}||${row[9]}`;
    mapByKey.set(key, row);
  }

  const values = [ROSTER_HEADERS, ...mapByKey.values()];
  console.log(`✅ CSV 중복 제거 완료. 최종 roster 행 수: ${values.length - 1}`);

  for (let i = 1; i < values.length; i++) {
    const docData = buildDocData(values[i]);
    await uploadRosterDoc(docData, i);
  }

  await updateRosterSheet(values);
  console.log("🎯 CSV roster 컬렉션 및 Google Sheets 업로드 완료!");
}

main().catch((err) => {
  console.error("❌ CSV roster 업로드 실패:", err);
  process.exit(1);
});
