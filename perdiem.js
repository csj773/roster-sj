// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { parseUTCDate, hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 PER DIEM -------------------
const PERDIEM_RATE = {
  LAX: 3.42,
  EWR: 3.44,
  HNL: 3.01,
  FRA: 3.18,
  BCN: 3.11,
  BKK: 2.14,
  DAD: 2.01,
  SFO: 3.42,
  OSL: 3.24,
  DAC: 30,
  NRT: 30,
  HKG: 30
};

// ------------------- Date 변환 -------------------
function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/); // ["Mon","01"]
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
  const [year, month, day] = baseDateStr.split(".").map(Number);
  const date = new Date(year, month - 1, day, Number(hh), Number(mm));
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
  const rows = raw.values.slice(1); // 헤더 제외
  const perdiemList = [];

  const now = new Date();
  const Year = String(now.getFullYear());
  const Month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getMonth()];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const [DateStr, DC, CIL, COL, Activity, F, From, STDL, STDZ, To, STAL, STAZ] = row;
    if (!Activity || !From || !To || From === To) continue;

    const DateFormatted = convertDate(DateStr);
    let StayHours = "0:00";
    let Rate = PERDIEM_RATE[To] || 3;
    let Total = 0;

    // 기본 RI/RO는 현재 편 STDZ/STA(Z)
    let riDate = parseHHMMOffset(STAL, DateFormatted); // previous 편 STA
    let roDate = parseHHMMOffset(STDZ, DateFormatted); // present 편 STD

    // 해외공항 → ICN 구간 처리
    if (To === "ICN" && i > 0) {
      const prevRow = rows[i - 1];
      const prevTo = prevRow[9];
      if (prevTo && prevTo !== "ICN") {
        const prevDateFormatted = convertDate(prevRow[0]);
        const prevSTA = prevRow[11];
        const prevSTD = prevRow[8];
        const prevRate = PERDIEM_RATE[prevTo] || 3;

        const prevRI = parseHHMMOffset(prevSTA, prevDateFormatted);
        const currentRO = parseHHMMOffset(STDZ, DateFormatted);
        const perd = calculatePerDiem(prevRI, currentRO, prevRate);

        // 이전 편 데이터 업데이트
        const existing = perdiemList.find(p => p.Destination === prevTo && p.Date === prevDateFormatted);
        if (existing) {
          existing.StayHours = perd.StayHours;
          existing.Total = perd.Total;
        }
      }

      // ICN 도착 편 초기화
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = riDate;
      StayHours = "0:00";
      Total = 0;
    }

    perdiemList.push({
      Date: DateFormatted,
      Destination: To,
      Month,
      RI: riDate ? riDate.toISOString() : "",
      RO: roDate ? roDate.toISOString() : "",
      Rate,
      StayHours,
      Total,
      Year
    });
  }

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  const headers = ["Date","Destination","Month","RI","RO","Rate","StayHours","Total","Year"];
  const csvRows = [headers.join(",")];
  for (const row of perdiemList) {
    csvRows.push(headers.map(h => `"${row[h] || ""}"`).join(","));
  }

  const fullPath = path.isAbsolute(outputPath) ? outputPath : path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, csvRows.join("\n"), "utf-8");
  console.log(`✅ CSV 저장 완료: ${fullPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, pdcUserName) {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    // 중복 제거
    const snapshot = await collection.where("Destination","==",row.Destination)
                                     .where("Date","==",row.Date)
                                     .get();
    if (!snapshot.empty) {
      for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
    }

    await collection.add({
      Date: row.Date,
      Destination: row.Destination,
      Month: row.Month,
      RI: row.RI,
      RO: row.RO,
      Rate: row.Rate,
      StayHours: row.StayHours,
      Total: row.Total,
      Year: row.Year,
      pdc_user_name: pdcUserName || ""
    });
  }

  console.log("✅ Firestore 업로드 완료");
}

export { PERDIEM_RATE, convertDate, calculatePerDiem };

