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

// ------------------- PerDiem 계산 -------------------
function calculatePerDiem(riUTC, roUTC, destination) {
  const start = parseUTCDate(riUTC);
  const end = parseUTCDate(roUTC);
  if (!start || !end || start >= end) return { StayHours: "0:00", Rate: 0, Total: 0 };
  const diffHours = (end - start) / 1000 / 3600;
  const rate = PERDIEM_RATE[destination] || 3; 
  const total = Math.round(diffHours * rate * 100) / 100;
  return { StayHours: hourToTimeStr(diffHours), Rate: rate, Total: total };
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
    if (!Activity || !From || !To) continue;

    const DateFormatted = convertDate(DateStr);
    let riUTC = STAZ;
    let roUTC = STAZ;
    let StayHours = "0:00";
    let Rate = PERDIEM_RATE[To] || 3;
    let Total = 0;

    // 해외공항 → ICN 구간 Stay 계산
    if (To === "ICN" && i > 0) {
      const prevRow = rows[i - 1];
      const prevTo = prevRow[9]; 
      const prevSTA = prevRow[11]; 
      if (prevTo !== "ICN") {
        const perd = calculatePerDiem(prevSTA, STAZ, prevTo);
        const prevDateFormatted = convertDate(prevRow[0]);
        const existing = perdiemList.find(p => p.Destination === prevTo && p.Date === prevDateFormatted);
        if (existing) {
          existing.StayHours = perd.StayHours;
          existing.Rate = perd.Rate;
          existing.Total = perd.Total;
        }
      }
      StayHours = "0:00";
      Total = 0;
    }

    // 해외공항 → ICN 이전 구간 제외하고 From=ICN 행은 StayHours=0, Total=0
    if (From === "ICN") {
      StayHours = "0:00";
      Total = 0;
      Rate = 3; 
    }

    // From ≠ To 행만 저장
    if (From !== To) {
      perdiemList.push({
        Date: DateFormatted,
        Destination: To,
        Month,
        RI: riUTC,
        RO: roUTC,
        Rate,
        StayHours,
        Total,
        Year
      });
    }
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
  const fullPath = path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, csvRows.join("\n"), "utf-8");
  console.log(`✅ CSV 저장 완료: ${fullPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, pdc_user_name) {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
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
      pdc_user_name
    });
  }

  console.log("✅ Firestore 업로드 완료");
}

// ------------------- ES 모듈 Export -------------------
export { PERDIEM_RATE, convertDate, calculatePerDiem };