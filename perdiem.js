// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 PER DIEM -------------------
export const PERDIEM_RATE = {
  LAX: 3.42, EWR: 3.44, HNL: 3.01, FRA: 3.18, BCN: 3.11,
  BKK: 2.14, DAD: 2.01, SFO: 3.42, OSL: 3.24,
  DAC: 33, NRT: 33, HKG: 33
};

// ------------------- Date 변환 -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 2) return input;
  const dayStr = parts[1].padStart(2, "0");
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  return `${year}.${month}.${dayStr}`;
}

// ------------------- HHMM±Offset → Date 변환 -------------------
function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const baseDateParts = baseDateStr.split(".");
  let date = new Date(
    Number(baseDateParts[0]),
    Number(baseDateParts[1]) - 1,
    Number(baseDateParts[2]),
    Number(hh),
    Number(mm)
  );
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

// ------------------- PerDiem 계산 -------------------
function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) return { StayHours: "0:00", Total: 0 };
  const diffHours = (roDate - riDate) / 1000 / 3600;
  const total = Math.round(diffHours * rate * 100) / 100;
  return { StayHours: hourToTimeStr(diffHours), Total: total };
}

// ------------------- Roster.json → PerDiem 리스트 -------------------
export function generatePerDiemList(rosterJsonPath) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);

  // Date 기준 오름차순 정렬
  rows.sort((a, b) => {
    const dateA = new Date(convertDate(a[0]));
    const dateB = new Date(convertDate(b[0]));
    return dateA - dateB;
  });

  const perdiemList = [];
  const now = new Date();
  const Year = String(now.getFullYear());
  const Month = String(now.getMonth() + 1).padStart(2, "0");

  // Flight 전용 배열 (From ≠ To)
  const flightRows = rows.filter(r => r[6] && r[9] && r[6] !== r[9]);

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity, , From, , STDZ, To, , STAZ] = row;
    const DateFormatted = convertDate(DateStr);

    // Rate 결정: ICN 출발이면 0, 그 외는 From 공항 기준
    const Rate = From === "ICN" ? 0 : PERDIEM_RATE[From] || 3;

    // 이전 Flight STA(Z) 탐색
    let riDate = null;
    if (Rate > 0) {
      for (let j = i - 1; j >= 0; j--) {
        const prevRow = flightRows[j];
        const prevFrom = prevRow[6];
        const prevTo = prevRow[9];
        const prevSTAZ = prevRow[11];
        if (prevFrom && prevTo && prevFrom !== prevTo) {
          const prevDate = convertDate(prevRow[0]);
          const tempRI = parseHHMMOffset(prevSTAZ, prevDate);
          if (tempRI instanceof Date && !isNaN(tempRI)) {
            riDate = tempRI;
            break;
          }
        }
      }
    }

    // 이전 Flight 없거나 ICN 출발 Flight는 현재 Flight STAZ 사용
    if (!riDate) riDate = parseHHMMOffset(STAZ, DateFormatted);

    const roDate = parseHHMMOffset(STDZ, DateFormatted);
    const riValid = riDate instanceof Date && !isNaN(riDate) ? riDate : null;
    const roValid = roDate instanceof Date && !isNaN(roDate) ? roDate : null;

    const { StayHours, Total } = calculatePerDiem(riValid, roValid, Rate);

    perdiemList.push({
      Date: DateFormatted,
      Activity,
      From,
      Destination: To,
      RI: riValid ? riValid.toISOString() : "",
      RO: roValid ? roValid.toISOString() : "",
      StayHours,
      Rate,
      Total,
      Month,
      Year
    });
  }

  return perdiemList;
}

// ------------------- CSV 저장 (Flight 전용) -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  const headers = ["Date","Activity","From","RI","Destination","RO","StayHours","Rate","Total"];
  const csvRows = [headers.join(",")];

  for (const row of perdiemList) {
    if (!row.From || !row.Destination || row.From === row.Destination) continue;
    const csvRow = [
      row.Date || "",
      row.Activity || "",
      row.From || "",
      row.RI ? row.RI.slice(11,16) : "",
      row.Destination || "",
      row.RO ? row.RO.slice(11,16) : "",
      row.StayHours || "",
      row.Rate || "",
      row.Total || ""
    ];
    csvRows.push(csvRow.map(v => `"${v}"`).join(","));
  }

  const fullPath = path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, csvRows.join("\n"), "utf-8");
  console.log(`✅ Flight 전용 CSV 저장 완료: ${fullPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, userId) {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    if (!row.Destination) continue;

    const snapshot = await collection
      .where("Destination","==",row.Destination)
      .where("Date","==",row.Date)
      .get();

    if (!snapshot.empty) {
      for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
    }

    await collection.add({
      Date: row.Date,
      Activity: row.Activity,
      From: row.From,
      Destination: row.Destination,
      RI: row.RI,
      RO: row.RO,
      StayHours: row.StayHours,
      Rate: row.Rate,
      Total: row.Total,
      Month: row.Month,
      Year: row.Year,
      userId
    });
  }
  console.log("✅ PerDiem Firestore 업로드 완료");
}

