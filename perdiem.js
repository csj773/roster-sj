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

// ------------------- Date 변환 -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/); // ["Mon","01"]
  if (parts.length !== 2) return input;
  const dayStr = parts[1].padStart(2, "0");
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  return `${year}.${month}.${dayStr}`;
}

// ------------------- PerDiem 리스트 생성 -------------------
export function generatePerDiemList(rosterJsonPath, pdc_user_name) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1); // 헤더 제외
  const perdiemList = [];

  let prevRO = null; // 이전 해외공항 도착 시각(Date)
  let prevTo = null; // 이전 목적지

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const [DateStr, , , , Activity, , From, , STDZ, To, , STAZ] = row;
    if (!Activity || !From || !To || From === To) continue;

    const DateFormatted = convertDate(DateStr);
    const riUTC = STAZ ? parseUTCDate(STAZ) : null; // 현재 STA(Z) → Date 객체
    const roUTC = STDZ ? parseUTCDate(STDZ) : null; // 현재 STD(Z) → Date 객체

    let StayHours = "0:00";
    let Rate = PERDIEM_RATE[To] || 3;
    let Total = 0;

    // 해외공항 출발 → ICN 도착 구간 계산
    if (To === "ICN" && prevRO && prevTo && prevTo !== "ICN") {
      const diffHours = (roUTC - prevRO) / 1000 / 3600;
      StayHours = hourToTimeStr(diffHours);
      Rate = PERDIEM_RATE[prevTo] || 3;
      Total = Math.round(diffHours * Rate * 100) / 100;

      // 이전 해외공항 출발편 행 업데이트
      const existing = perdiemList.find(p => p.Destination === prevTo && p.Date === DateFormatted);
      if (existing) {
        existing.StayHours = StayHours;
        existing.Rate = Rate;
        existing.Total = Total;
      }
      // ICN 도착편은 0
      StayHours = "0:00";
      Total = 0;
    }

    perdiemList.push({
      Date: DateFormatted,
      Destination: To,
      Month: DateFormatted.slice(5,7), // MM
      RI: riUTC ? riUTC.toISOString() : "", // null 검사 추가
      RO: roUTC ? roUTC.toISOString() : "", // null 검사 추가
      Rate,
      StayHours,
      Total,
      Year: DateFormatted.slice(0,4),
      pdc_user_name
    });

    // 이전 해외공항 정보 업데이트
    if (To !== "ICN") {
      prevRO = roUTC;
      prevTo = To;
    }
  }

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  const headers = ["Date","Destination","Month","RI","RO","Rate","StayHours","Total","Year","pdc_user_name"];
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
    // 중복 제거: Destination + Date
    const snapshot = await collection.where("Destination","==",row.Destination)
                                     .where("Date","==",row.Date)
                                     .get();
    if (!snapshot.empty) {
      for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
    }

    // Firestore 저장: pdc_user_name 포함
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