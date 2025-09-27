// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { parseUTCDate, hourToTimeStr } from "./flightTimeUtils.js";

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
    return {
      StayHours: "0:00",
      Rate: PERDIEM_RATE[destination],
      Total: PERDIEM_RATE[destination]
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

  const now = new Date();
  const Month = now.toLocaleString("en-US", { month: "short" });
  const Year = now.getFullYear();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const [Date, DC, CIL, COL, Activity, F, From, STDL, STDZ, To, STAL, STAZ] = row;

    if (!Activity || !From || !To || To === "ICN") continue; // ICN 제외

    // RI 시작: STA(Z) 현재 행
    const riUTC = STAZ;
    let roUTC;
    // RO 종료: 다음 행 STD(Z) 가 같은 Destination이면 다음 행, 아니면 현재 STA(Z)
    if (i + 1 < rows.length && rows[i + 1][6] !== To) {
      roUTC = STAZ;
    } else if (i + 1 < rows.length) {
      roUTC = rows[i + 1][8];
    } else {
      roUTC = STAZ;
    }

    const { StayHours, Rate, Total } = calculatePerDiem(riUTC, roUTC, To);

    perdiemList.push({
      Date: roUTC,
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
  const headers = [
    "Date",
    "Destination",
    "Month",
    "RI",
    "RO",
    "Rate",
    "StayHours",
    "Total",
    "Year"
  ];

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
export async function uploadPerDiemFirestore(perdiemList, inputUserId, inputPdcUserName) {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  // 환경변수 또는 전달받은 값
  const userId =
    process.env.FIREBASE_UID || inputUserId || process.env.INPUT_FIREBASE_UID || "";
  const pdc_user_name =
    process.env.PDC_USER_NAME || inputPdcUserName || process.env.INPUT_PDC_USERNAME || "";

  for (const row of perdiemList) {
    if (!row.Destination || !row.Date) continue;

    // 중복 조회: Destination + Date
    const snapshot = await collection
      .where("Destination", "==", row.Destination)
      .where("Date", "==", row.Date)
      .get();

    const docData = {
      Date: row.Date,
      Destination: row.Destination,
      Month: row.Month,
      RI: row.RI,
      RO: row.RO,
      Rate: row.Rate,
      StayHours: row.StayHours,
      Total: row.Total,
      Year: row.Year,
      userId,
      pdc_user_name
    };

    // undefined 제거
    Object.keys(docData).forEach(key => {
      if (docData[key] === undefined) delete docData[key];
    });

    if (!snapshot.empty) {
      // 중복이 있으면 첫 번째 문서만 업데이트
      const docId = snapshot.docs[0].id;
      await collection.doc(docId).update(docData);
    } else {
      // 없으면 새로 추가
      await collection.add(docData);
    }
  }

  console.log("✅ Firestore 업로드 완료 (중복은 업데이트, 신규는 추가)");
}