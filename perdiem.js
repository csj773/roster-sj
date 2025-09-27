// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { parseUTCDate, hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 고정 Per Diem -------------------
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
  DAC: 30, // 특수: 체류 없이 고정
  NRT: 30,
  HKG: 30,
};

// ------------------- Perdiem 계산 -------------------
export function calculatePerDiem(riUTC, roUTC, destination) {
  if (PERDIEM_RATE[destination]) {
    return {
      StayHours: "0:00",
      Rate: PERDIEM_RATE[destination],
      Total: PERDIEM_RATE[destination],
    };
  }

  const start = parseUTCDate(riUTC);
  const end = parseUTCDate(roUTC);
  if (!start || !end || start >= end)
    return { StayHours: "0:00", Rate: 0, Total: 0 };

  const diffHours = (end - start) / 1000 / 3600;
  const rate = 3; // 기본 per diem rate
  const total = Math.round(diffHours * rate * 100) / 100;

  return { StayHours: hourToTimeStr(diffHours), Rate: rate, Total: total };
}

// ------------------- Roster.json → Perdiem 리스트 -------------------
export function generatePerDiemList(rosterJsonPath) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1); // 헤더 제외
  const perdiemList = [];

  for (let i = 0; i < rows.length - 1; i++) {
    const row = rows[i];
    const nextRow = rows[i + 1];

    const [
      FlightDate,
      DC,
      CIL,
      COL,
      Activity,
      F,
      From,
      STDL,
      STDZ,
      To,
      STAL,
      STAZ,
    ] = row;

    const [
      nextFlightDate,
      nextDC,
      nextCIL,
      nextCOL,
      nextActivity,
      nextF,
      nextFrom,
      nextSTDL,
      nextSTDZ,
      nextTo,
      nextSTAL,
      nextSTAZ,
    ] = nextRow;

    if (!Activity || !From || !To) continue;
    if (To === "ICN") continue; // ICN 제외

    // 연속 두 행 비교: Stay 시작 = 현재 STA(Z), 종료 = 다음 STD(Z)
    if (From === To) continue; // Same origin/destination 제외

    const riUTC = STAZ;
    const roUTC = nextSTDZ;

    const { StayHours, Rate, Total } = calculatePerDiem(riUTC, roUTC, To);

    const now = new Date();
    const Month = now.toLocaleString("en-US", { month: "short" });
    const Year = now.getFullYear();

    perdiemList.push({
      Destination: To,
      RI: riUTC,
      RO: roUTC,
      StayHours,
      Rate,
      Total,
      Month,
      Year,
      Date: roUTC, // 귀국편 도착일 기준
      owner: "",
    });
  }

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  const headers = [
    "Date",
    "Destination",
    "Month",
    "RI",
    "RO",
    "Rate",
    "StayHours",
    "Total",
    "Year",
    "owner",
  ];
  const csvRows = [headers.join(",")];

  for (const row of perdiemList) {
    csvRows.push(
      headers.map((h) => `"${row[h] || ""}"`).join(",")
    );
  }

  const fullPath = path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, csvRows.join("\n"), "utf-8");
  console.log(`✅ CSV 저장 완료: ${fullPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(
  perdiemList,
  userId,
  pdc_user_name
) {
  if (!admin.apps.length)
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    // 중복 제거: Destination + Date
    const snapshot = await collection
      .where("Destination", "==", row.Destination)
      .where("Date", "==", row.Date)
      .get();
    if (!snapshot.empty) {
      for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
    }

    await collection.add({
      Destination: row.Destination,
      RI: row.RI,
      RO: row.RO,
      StayHours: row.StayHours,
      Rate: row.Rate,
      Total: row.Total,
      Month: row.Month,
      Year: row.Year,
      Date: row.Date,
      owner: "",
      userId,
      pdc_user_name,
    });
  }

  console.log("✅ Firestore 업로드 완료");
}