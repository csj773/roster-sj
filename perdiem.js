// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 PER DIEM -------------------
export const PERDIEM_RATE = {
  LAX: 3.42, EWR: 3.44, HNL: 3.01, FRA: 3.18, BCN: 3.11,
  NRT: 3.05, ICN: 0.0
};

// ------------------- Date 변환 -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") {
    const now = new Date();
    return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  }
  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) {
    const now = new Date();
    return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  }
  const year = new Date().getFullYear();
  const monthMap = {
    Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
    Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12"
  };
  let month, dayStr;
  if (monthMap[parts[0]]) {
    month = monthMap[parts[0]];
    dayStr = parts[1].padStart(2, "0");
  } else {
    month = String(new Date().getMonth() + 1).padStart(2, "0");
    dayStr = parts[1].padStart(2, "0");
  }
  return `${year}.${month}.${dayStr}`;
}

// ------------------- YYYY.MM.DD → Date -------------------
export function parseUTCDate(str) {
  if (!str) return null;
  const parts = str.split(".");
  if (parts.length < 3) return null;
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
}

// ------------------- HHMM±Offset → Date -------------------
function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const [y, m, d] = baseDateStr.split(".");
  let date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm));
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

// ------------------- Roster.json → PerDiem 리스트 -------------------
export async function generatePerDiemList(rosterJsonPath, userId) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);

  // 날짜 순 정렬
  rows.sort((a, b) => new Date(convertDate(a[0])) - new Date(convertDate(b[0])));

  let perdiemList = [];
  let prevDateObj = null;
  let grandTotal = 0;

  for (const row of rows) {
    const [DateStr, FlightNo, From, To, STDZ, STAZ] = row;
    let DateFormatted = convertDate(DateStr);
    let currentDateObj = parseUTCDate(DateFormatted);

    // 롤오버 보정
    if (prevDateObj && currentDateObj < prevDateObj) {
      currentDateObj.setMonth(currentDateObj.getMonth() + 1);
    }
    DateFormatted = `${currentDateObj.getFullYear()}.${String(currentDateObj.getMonth()+1).padStart(2,"0")}.${String(currentDateObj.getDate()).padStart(2,"0")}`;
    prevDateObj = currentDateObj;

    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0], Month = dfParts[1];
    const rate = PERDIEM_RATE[To] ?? 0;

    const riDate = parseHHMMOffset(STAZ, DateFormatted);
    const roDate = parseHHMMOffset(STDZ, DateFormatted);

    let StayHours = "0:00";
    let Total = 0;
    if (riDate && roDate && riDate < roDate) {
      const diffHrs = (roDate - riDate) / 1000 / 3600;
      StayHours = hourToTimeStr(diffHrs);
      Total = Math.round(diffHrs * rate * 100) / 100;
    }

    grandTotal += Total;

    perdiemList.push({
      Date: DateFormatted,
      FlightNo,
      From,
      Destination: To,
      RI: riDate ? riDate.toISOString() : "",
      RO: roDate ? roDate.toISOString() : "",
      StayHours,
      Rate: rate,
      Total,
      Month,
      Year
    });
  }

  return { perdiemList, GrandTotal: Math.round(grandTotal * 100) / 100 };
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  const headers = ["Date","FlightNo","From","Destination","RI","RO","StayHours","Rate","Total"];
  const csvRows = [headers.join(",")];
  for (const row of perdiemList) {
    csvRows.push([
      row.Date, row.FlightNo, row.From, row.Destination,
      row.RI ? row.RI.slice(11,16) : "",
      row.RO ? row.RO.slice(11,16) : "",
      row.StayHours, row.Rate, row.Total
    ].map(v => `"${v}"`).join(","));
  }
  const fullPath = path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, csvRows.join("\n"), "utf-8");
  console.log(`✅ CSV 저장 완료: ${fullPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, owner) {
  if (!Array.isArray(perdiemList) || !owner) return;
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    const snapshot = await collection
      .where("Destination","==",row.Destination)
      .where("Date","==",row.Date)
      .get();
    if (!snapshot.empty) {
      for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
    }
    await collection.add({ ...row, owner });
  }
  console.log("✅ Firestore 업로드 완료");
}