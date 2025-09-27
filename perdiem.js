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
  const start = parseUTCDate(riUTC);
  const end = parseUTCDate(roUTC);
  if (!start || !end || start >= end) return { StayHours: 0, Total: 0, Rate: PERDIEM_RATE[destination] || 0 };

  const diffHours = (end - start) / 1000 / 3600;
  const rate = PERDIEM_RATE[destination] || 3;
  const total = Math.round(diffHours * rate * 100) / 100;

  return { StayHours: diffHours, Total: total, Rate: rate };
}

// ------------------- Roster.json → Perdiem 리스트 -------------------
export function generatePerDiemList(rosterJsonPath) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);
  const perdiemList = [];

  const now = new Date();
  const Month = now.toLocaleString("en-US", { month: "short" });
  const Year = now.getFullYear();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let [DateStr, DC, CIL, COL, Activity, F, From, STDL, STDZ, To, STAL, STAZ] = row;

    if (!Activity || !From || !To) continue;

    const DateFormatted = convertDate(DateStr);

    // ICN 도착 구간 처리
    if (To === "ICN") {
      // 이전 행 해외공항 출발 시간
      const prevRow = rows[i - 1];
      if (prevRow) {
        const prevTo = prevRow[9]; // To
        const prevSTA = prevRow[11]; // STA(Z)
        if (prevTo !== "ICN") {
          const { StayHours, Total, Rate } = calculatePerDiem(prevSTA, STAZ, prevTo);
          // 해외공항 출발행에 StayHours/Total 저장
          const existing = perdiemList.find(p => p.Destination === prevTo && p.Date === convertDate(prevRow[0]));
          if (existing) {
            existing.StayHours = StayHours;
            existing.Total = Total;
          }
        }
      }
      continue; // ICN 자체는 리스트에 추가하지 않음
    }

    // From ≠ To만 계산
    if (From !== To) {
      const riUTC = STAZ; // 현재 행 도착 시간
      let roUTC;
      // 다음 행이 같은 해외공항이면 roUTC는 다음 행 STD(Z)
      if (i + 1 < rows.length && rows[i + 1][6] === To) {
        roUTC = rows[i + 1][8];
      } else {
        roUTC = STAZ;
      }

      const { StayHours, Total, Rate } = calculatePerDiem(riUTC, roUTC, To);

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
export async function uploadPerDiemFirestore(perdiemList) {
  const userId = process.env.FIREBASE_UID || process.env.INPUT_FIREBASE_UID || process.env.SECRETS_FIREBASE_UID;
  const pdc_user_name = process.env.PDC_USERNAME || process.env.INPUT_PDC_USERNAME || process.env.SECRETS_PDC_USERNAME;

  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    const snapshot = await collection.where("Destination","==",row.Destination)
                                     .where("Date","==",row.Date)
                                     .get();
    if (!snapshot.empty) {
      const docId = snapshot.docs[0].id;
      await collection.doc(docId).set({ ...row, userId, pdc_user_name }, { merge: true });
    } else {
      await collection.add({ ...row, userId, pdc_user_name });
    }
  }

  console.log("✅ Firestore 업로드 완료");
}