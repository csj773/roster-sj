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
  DAC: 33,
  NRT: 33,
  HKG: 33
};

// ------------------- Roster CSV 생성 -------------------
export function generateRosterCSV(rosterJsonPath, outputPath = "public/roster.csv") {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1); // 헤더 제외
  const headers = raw.values[0]; // 헤더 포함

  const csvRows = [headers.join(",")];
  for (const row of rows) {
    csvRows.push(row.map(cell => `"${cell || ""}"`).join(","));
  }

  const fullPath = path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, csvRows.join("\n"), "utf-8");
  console.log(`✅ Roster CSV 저장 완료: ${fullPath}`);

  return fullPath;
}

// ------------------- PerDiem CSV 생성 -------------------
export function generatePerDiemCSV(rosterCSVPath, perdiemCSVPath = "public/perdiem.csv") {
  const data = fs.readFileSync(rosterCSVPath, "utf-8");
  const rows = data.split("\n").slice(1).map(line => line.split(",").map(cell => cell.replace(/"/g, "")));
  const headers = ["Date", "Destination", "Month", "RI", "RO", "Rate", "StayHours", "Total", "Year", "pdc_user_name"];
  const perdiemList = [];
  const csvRows = [headers.join(",")];

  let prevRO = null; // 이전 해외공항 도착 시각(Date)
  let prevTo = null; // 이전 목적지

  for (const row of rows) {
    const [DateStr, , , , Activity, , From, , STDZ, To, , STAZ] = row;
    if (!Activity || !From || !To || From === To) continue;

    const DateFormatted = convertDate(DateStr);
    const riUTC = STAZ ? parseUTCDate(STAZ) : null;
    const roUTC = STDZ ? parseUTCDate(STDZ) : null;

    let StayHours = "0:00";
    let Rate = PERDIEM_RATE[To] || 3;
    let Total = 0;

    if (To === "ICN" && prevRO && prevTo && prevTo !== "ICN") {
      const diffHours = (roUTC - prevRO) / 1000 / 3600;
      StayHours = hourToTimeStr(diffHours);
      Rate = PERDIEM_RATE[prevTo] || 3;
      Total = Math.round(diffHours * Rate * 100) / 100;
    }

    perdiemList.push({
      Date: DateFormatted,
      Destination: To,
      Month: DateFormatted.slice(5, 7),
      RI: riUTC ? riUTC.toISOString() : "",
      RO: roUTC ? roUTC.toISOString() : "",
      Rate,
      StayHours,
      Total,
      Year: DateFormatted.slice(0, 4),
      pdc_user_name: ""
    });

    csvRows.push([
      DateFormatted,
      To,
      DateFormatted.slice(5, 7),
      riUTC ? riUTC.toISOString() : "",
      roUTC ? roUTC.toISOString() : "",
      Rate,
      StayHours,
      Total,
      DateFormatted.slice(0, 4),
      ""
    ].join(","));

    if (To !== "ICN") {
      prevRO = roUTC;
      prevTo = To;
    }
  }

  const fullPath = path.join(process.cwd(), perdiemCSVPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, csvRows.join("\n"), "utf-8");
  console.log(`✅ PerDiem CSV 저장 완료: ${fullPath}`);

  return perdiemList;
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, pdc_user_name) {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    const snapshot = await collection.where("Destination", "==", row.Destination)
                                     .where("Date", "==", row.Date)
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

// ------------------- Helper: Date 변환 -------------------
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

// ✅ 기존 함수 이름과 호환되도록 alias export
export { generatePerDiemCSV as generatePerDiemList };
export { generateRosterCSV as savePerDiemCSV };
