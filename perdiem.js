// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 PER DIEM -------------------
export const PERDIEM_RATE = {
  LAX: 3.42, EWR: 3.44, HNL: 3.01, FRA: 3.18, BCN: 3.11,
  BKK: 2.14, DAD: 2.01, SFO: 3.42, OSL: 3.24,
  DAC: 33, NRT: 33, HKG: 33
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

// ------------------- HHMM±Offset → Date 변환 -------------------
function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const baseDateParts = baseDateStr.split(".");
  let date = new Date(Number(baseDateParts[0]), Number(baseDateParts[1])-1, Number(baseDateParts[2]), Number(hh), Number(mm));
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

// ------------------- PerDiem 계산 -------------------
export function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) return { StayHours: "0:00", Total: 0 };
  const diffHours = (roDate - riDate) / 1000 / 3600;
  const total = Math.round(diffHours * rate * 100) / 100;
  return { StayHours: hourToTimeStr(diffHours), Total: total };
}

// ------------------- Roster.json → PerDiem 리스트 -------------------
export function generatePerDiemList(rosterJsonPath) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);
  const perdiemList = [];
  const now = new Date();
  const Month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getMonth()];
  const Year = String(now.getFullYear());

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const [DateStr,, , , Activity,, From,, STDZ, To,, STAZ] = row;
    if (!Activity || !From || !To || From === To) continue;

    const DateFormatted = convertDate(DateStr);
    const Rate = PERDIEM_RATE[To] || 3;

    // 이전 Flight의 RO를 RI로 사용
    let riDate = null;
    if (perdiemList.length > 0) {
      const prevFlight = perdiemList[perdiemList.length - 1];
      riDate = prevFlight.RO ? new Date(prevFlight.RO) : parseHHMMOffset(STAZ, DateFormatted);
    } else {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
    }

    // 현재 Flight의 STD(Z)를 RO로 사용
    const roDate = parseHHMMOffset(STDZ, DateFormatted);

    // StayHours와 Total 계산
    const { StayHours, Total } = calculatePerDiem(riDate, roDate, Rate);

    perdiemList.push({
      Date: DateFormatted,
      Activity: Activity,
      From,
      STDZ,
      Destination: To,
      STAZ,
      Month,
      Year,
      RI: riDate ? riDate.toISOString() : "",
      RO: roDate ? roDate.toISOString() : "",
      StayHours,
      Total,
      Rate
    });
  }

  return perdiemList;
}

// ------------------- CSV 저장 (Flight 전용 헤더) -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  const headers = ["Date","Activity","From","STD(Z)","To","STA(Z)"];
  const csvRows = [headers.join(",")];

  const flightRows = perdiemList.filter(p => p.From && p.To && p.From !== p.To);

  for (const row of flightRows) {
    const csvRow = [
      row.Date || "",
      "Flight",
      row.From || "",
      row.RI ? row.RI.slice(11,16) : "",
      row.Destination || "",
      row.RO ? row.RO.slice(11,16) : ""
    ];
    csvRows.push(csvRow.map(v => `"${v}"`).join(","));
  }

  const fullPath = path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, csvRows.join("\n"), "utf-8");
  console.log(`✅ Flight 전용 CSV 저장 완료: ${fullPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, pdc_user_name) {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    if (!row.From || !row.To || row.From === row.To) continue; // Flight만 업로드

    const snapshot = await collection.where("Destination","==",row.Destination)
                                     .where("Date","==",row.Date)
                                     .get();
    if (!snapshot.empty) {
      for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
    }

    await collection.add({
      Date: row.Date,
      Destination: row.Destination,
      RI: row.RI,
      RO: row.RO,
      StayHours: row.StayHours,
      Rate: row.Rate,
      Total: row.Total,
      pdc_user_name
    });
  }

  console.log("✅ Firestore 업로드 완료");
}
