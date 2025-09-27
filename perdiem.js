// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { parseUTCDate, hourToTimeStr, convertDate } from "./flightTimeUtils.js";

// ------------------- 공항별 고정 Per Diem -------------------
const PERDIEM_RATE = {
  DAC: 30,
  NRT: 30,
  HKG: 30,
  LAX: 3.42,
  EWR: 3.44,
  HNL: 3.01,
  FRA: 3.18,
  BCN: 3.11,
  BKK: 2.14,
  DAD: 2.01,
  SFO: 3.42,
  OSL: 3.24
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

  const now = new Date();
  const Month = now.toLocaleString("en-US", { month: "short" });
  const Year = now.getFullYear();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let [DateStr, DC, CIL, COL, Activity, F, From, STDL, STDZ, To, STAL, STAZ] = row;

    if (!Activity || !From || !To || To === "ICN" || From === To) continue;

    // ------------------ Date 변환 ------------------
    const DateFormatted = convertDate(DateStr); // "YYYY.MM.DD"

    // RI 시작: STA(Z) 현재 행
    const riUTC = STAZ;
    let roUTC;
    if (i + 1 < rows.length && rows[i + 1][6] === To) {
      roUTC = rows[i + 1][8];
    } else {
      roUTC = STAZ;
    }

    const { StayHours, Rate, Total } = calculatePerDiem(riUTC, roUTC, To);

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
export async function uploadPerDiemFirestore(perdiemList) {
  // 환경변수 / secrets 처리
  const userId = process.env.FIREBASE_UID || process.env.INPUT_FIREBASE_UID || process.env.SECRETS_FIREBASE_UID;
  const pdc_user_name = process.env.PDC_USERNAME || process.env.INPUT_PDC_USERNAME || process.env.SECRETS_PDC_USERNAME;

  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    // 중복 체크: Destination + Date
    const snapshot = await collection.where("Destination","==",row.Destination)
                                     .where("Date","==",row.Date)
                                     .get();
    if (!snapshot.empty) {
      // 첫 번째 문서만 업데이트
      const docId = snapshot.docs[0].id;
      await collection.doc(docId).set({
        ...row,
        userId,
        pdc_user_name
      }, { merge: true });
    } else {
      await collection.add({
        ...row,
        userId,
        pdc_user_name
      });
    }
  }

  console.log("✅ Firestore 업로드 완료");
}