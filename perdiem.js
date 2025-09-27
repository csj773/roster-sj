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
    const total = PERDIEM_RATE[destination]; // 고정 rate인 경우 총액 = rate
    return { StayHours: "0:00", Rate: PERDIEM_RATE[destination], Total: total };
  }

  const start = parseUTCDate(riUTC);
  const end = parseUTCDate(roUTC);
  if (!start || !end || start >= end) return { StayHours: "0:00", Rate: 0, Total: 0 };

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

    // 해외공항 → ICN 구간 계산
    if (To === "ICN" && i > 0) {
      const prevRow = rows[i - 1];
      const prevTo = prevRow[9]; // To
      const prevSTA = prevRow[11]; // STA(Z)

      if (prevTo !== "ICN") {
        const perd = calculatePerDiem(prevSTA, STAZ, prevTo);
        // 이전 해외공항 출발 행에 StayHours/Total 업데이트
        const prevDateFormatted = convertDate(prevRow[0]);
        const existing = perdiemList.find(p => p.Destination === prevTo && p.Date === prevDateFormatted);
        if (existing) {
          existing.StayHours = perd.StayHours;
          existing.Rate = perd.Rate;
          existing.Total = perd.Total;
        }
      }
    }

    // ICN 도착 행(From=ICN) StayHours=0, Total=0
    if (From === "ICN") {
      StayHours = "0:00";
      Total = 0;
    }

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
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  const userId = process.env.PERDIEM_USER_ID || process.env.USER_ID;
  const pdc_user_name = process.env.PDC_USER_NAME || process.env.PDC_SECRET_NAME;

  for (const row of perdiemList) {
    // 중복 확인: Destination + Date
    const snapshot = await collection.where("Destination","==",row.Destination)
                                     .where("Date","==",row.Date)
                                     .get();
    if (!snapshot.empty) {
      // 중복 존재 시 하나만 업데이트
      const doc = snapshot.docs[0];
      await collection.doc(doc.id).update({
        ...row,
        userId,
        pdc_user_name
      });
      continue;
    }

    // 신규 저장
    await collection.add({
      ...row,
      userId,
      pdc_user_name
    });
  }

  console.log("✅ Firestore 업로드 완료");
}