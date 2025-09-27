// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { parseUTCDate, hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 고정 Per Diem -------------------
const PERDIEM_RATE = {
  DAC: 30,
  NRT: 30,
  HKG: 30
  // 필요 시 다른 공항 rate 추가
};

// ------------------- Perdiem 계산 -------------------
export function calculatePerDiem(riUTC, roUTC, destination) {
  if (PERDIEM_RATE[destination]) {
    return { StayHours: "0:00", Rate: PERDIEM_RATE[destination], Total: PERDIEM_RATE[destination] };
  }

  const start = parseUTCDate(riUTC);
  const end = parseUTCDate(roUTC);
  if (!start || !end || start >= end) return { StayHours: "0:00", Rate: 0, Total: 0 };

  const diffHours = (end - start) / 1000 / 3600;
  const rate = 3; // 기본 per diem rate (필요시 공항별 조정 가능)
  const total = Math.round(diffHours * rate * 100) / 100;

  return { StayHours: hourToTimeStr(diffHours), Rate: rate, Total: total };
}

// ------------------- Roster.json → Perdiem 리스트 -------------------
export function generatePerDiemList(rosterJsonPath) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1); // 헤더 제외
  const perdiemList = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const [Date, DC, CIL, COL, Activity, F, From, STDL, STDZ, To, STAL, STAZ] = row;

    if (!Activity || !From || !To) continue;

    // 귀국편 도착일 기준
    let riUTC = STAZ;
    let roUTC;
    if (i + 1 < rows.length && rows[i + 1][6] === To) {
      roUTC = rows[i + 1][8]; // 다음 행 STD(Z)
    } else {
      roUTC = STAZ;
    }

    const { StayHours, Rate, Total } = calculatePerDiem(riUTC, roUTC, To);

    perdiemList.push({
      Destination: To,
      RI: riUTC,
      RO: roUTC,
      StayHours,
      Rate,
      Total,
      Date: roUTC // 귀국편 도착일 기준
    });
  }

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  const headers = ["Destination", "RI", "RO", "StayHours", "Rate", "Total", "Date"];
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
export async function uploadPerDiemFirestore(perdiemList, userId, pdc_user_name) {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    // 중복 제거: Destination + Date
    const snapshot = await collection.where("Destination", "==", row.Destination)
                                     .where("Date", "==", row.Date)
                                     .get();
    if (!snapshot.empty) {
      for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
    }

    // Firestore 저장 시 userId와 pdc_user_name 추가
    await collection.add({
      Destination: row.Destination,
      RI: row.RI,
      RO: row.RO,
      StayHours: row.StayHours,
      Rate: row.Rate,
      Total: row.Total,
      userId,
      pdc_user_name,
      Date: row.Date
    });
  }

  console.log("✅ Firestore 업로드 완료");
}
