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

// ------------------- Date 변환 (유연 처리) -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") return input;

  const parts = input.trim().split(/\s+/);
  const now = new Date();
  const year = now.getFullYear();

  const monthMap = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };

  // 1) Month Day 형식 (e.g., Oct 01)
  if (parts.length >= 2 && monthMap[parts[0]]) {
    const month = monthMap[parts[0]];
    const dayStr = parts[1].padStart(2, "0");
    return `${year}.${month}.${dayStr}`;
  }

  // 2) YYYY.MM.DD or YYYY/MM/DD
  const sep = input.includes("/") ? "/" : ".";
  const dateParts = input.split(sep);
  if (dateParts.length === 3) {
    const y = dateParts[0].padStart(4, "0");
    const m = dateParts[1].padStart(2, "0");
    const d = dateParts[2].padStart(2, "0");
    return `${y}.${m}.${d}`;
  }

  // 3) MM.DD 형식
  if (dateParts.length === 2) {
    const m = dateParts[0].padStart(2, "0");
    const d = dateParts[1].padStart(2, "0");
    return `${year}.${m}.${d}`;
  }

  // fallback
  return input.replace(/\//g, ".");
}

// ------------------- HHMM±Offset → Date 변환 -------------------
function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const baseDateParts = baseDateStr.split(".");
  let date = new Date(
    Number(baseDateParts[0]),
    Number(baseDateParts[1]) - 1,
    Number(baseDateParts[2]),
    Number(hh),
    Number(mm)
  );
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

// ------------------- PerDiem 계산 -------------------
function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) return { StayHours: "0:00", Total: 0 };
  const diffHours = (roDate - riDate) / 1000 / 3600;
  const total = Math.round(diffHours * rate * 100) / 100;
  return { StayHours: hourToTimeStr(diffHours), Total: total };
}

// ------------------- Roster.json → PerDiem 리스트 -------------------
export async function generatePerDiemList(rosterJsonPath, userId) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);

  rows.sort((a, b) => {
    const dateA = new Date(convertDate(a[0]));
    const dateB = new Date(convertDate(b[0]));
    return dateA - dateB;
  });

  const perdiemList = [];
  const now = new Date();

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const db = admin.firestore();

  const flightRows = rows.filter(r => r[6] && r[9]); // From, To 존재 여부만 확인
  const QUICK_DESTS = ["NRT", "HKG", "DAC"];

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity, , From, , STDZ, To, , STAZ] = row;

    let DateFormatted = convertDate(DateStr);
    if (!DateFormatted || !DateFormatted.includes(".")) {
      const prevRow = i > 0 ? flightRows[i - 1] : null;
      DateFormatted = prevRow ? convertDate(prevRow[0]) : `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")}`;
    }

    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0] || String(now.getFullYear());
    const Month = (dfParts[1] || "01").padStart(2,"0");
    const Day = (dfParts[2] || "01").padStart(2,"0");

    const defaultRate = From === "ICN" ? 0 : PERDIEM_RATE[From] || 3;
    let Rate = defaultRate;

    let riDate = null;
    let roDate = null;

    if (i === 0 && To === "ICN" && From !== "ICN") {
      const curMonthNum = Number(Month);
      const prevMonthNum = curMonthNum - 1 >= 1 ? curMonthNum - 1 : 12;
      const prevMonth = String(prevMonthNum).padStart(2,"0");
      const prevYear = prevMonthNum === 12 ? String(Number(Year)-1) : Year;

      const prevSnapshot = await db.collection("Perdiem")
        .where("userId","==",userId)
        .where("Month","==",prevMonth)
        .where("Year","==",prevYear)
        .where("Destination","==",From)
        .orderBy("Date","desc")
        .limit(1)
        .get();

      if (!prevSnapshot.empty) {
        const prevDoc = prevSnapshot.docs[0].data();
        if (prevDoc.RO) riDate = new Date(prevDoc.RO);
      }
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    } else {
      for (let j = i-1; j>=0; j--) {
        const prevRow = flightRows[j];
        if (prevRow[6] && prevRow[9]) {
          const tempRI = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
          if (tempRI instanceof Date && !isNaN(tempRI)) {
            riDate = tempRI;
            break;
          }
        }
      }
      if (!riDate) riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // Quick turn 귀국편
    let isQuickTurnReturn = false;
    if (To === "ICN" && QUICK_DESTS.includes(From) && i > 0) {
      const prevRow = flightRows[i-1];
      if (prevRow[6] === "ICN" && prevRow[9] === From) {
        const prevRI = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
        const curRO = parseHHMMOffset(STDZ, DateFormatted);
        if (prevRI instanceof Date && !isNaN(prevRI) && curRO instanceof Date && !isNaN(curRO)) {
          const diffHours = (curRO - prevRI)/1000/3600;
          if (diffHours > 0 && diffHours <= 8) {
            isQuickTurnReturn = true;
            riDate = prevRI;
            if (!DateStr || !DateStr.trim()) {
              DateFormatted = convertDate(prevRow[0]);
            }
          }
        }
      }
    }

    const riValid = riDate instanceof Date && !isNaN(riDate) ? riDate : null;
    const roValid = roDate instanceof Date && !isNaN(roDate) ? roDate : null;

    let { StayHours, Total: baseTotal } = calculatePerDiem(riValid, roValid, Rate);

    if (From === "ICN") StayHours = "0:00";
    let Total = isQuickTurnReturn ? 33 : baseTotal;
    if (isQuickTurnReturn) Rate = 33;

    perdiemList.push({
      Date: DateFormatted,
      Activity,
      From,
      Destination: To,
      RI: riValid ? riValid.toISOString() : "",
      RO: roValid ? roValid.toISOString() : "",
      StayHours,
      Rate,
      Total,
      Month,
      Year
    });
  }

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  if (!Array.isArray(perdiemList)) {
    console.warn("❌ savePerDiemCSV: perdiemList가 배열이 아닙니다.");
    return;
  }

  const headers = ["Date","Activity","From","RI","Destination","RO","StayHours","Rate","Total"];
  const csvRows = [headers.join(",")];

  for (const row of perdiemList) {
    if (!row || !row.From || !row.Destination) continue;
    const csvRow = [
      row.Date || "",
      row.Activity || "",
      row.From || "",
      row.RI ? row.RI.slice(11,16) : "",
      row.Destination || "",
      row.RO ? row.RO.slice(11,16) : "",
      row.StayHours || "",
      row.Rate || "",
      row.Total || ""
    ];
    csvRows.push(csvRow.map(v => `"${v}"`).join(","));
  }

  try {
    const fullPath = path.join(process.cwd(), outputPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, csvRows.join("\n"), "utf-8");
    console.log(`✅ Flight 전용 CSV 저장 완료: ${fullPath}`);
  } catch (err) {
    console.error("❌ CSV 저장 실패:", err);
  }
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, owner) {
  if (!Array.isArray(perdiemList) || !owner) {
    console.warn("❌ uploadPerDiemFirestore: perdiemList가 배열이 아니거나 owner가 없습니다.");
    return;
  }

  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    if (!row || !row.Destination) continue;

    try {
      const snapshot = await collection
        .where("Destination","==",row.Destination)
        .where("Date","==",row.Date)
        .get();

      if (!snapshot.empty) {
        for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
      }

      await collection.add({
        Date: row.Date,
        Activity: row.Activity,
        From: row.From,
        Destination: row.Destination,
        RI: row.RI,
        RO: row.RO,
        StayHours: row.StayHours,
        Rate: row.Rate,
        Total: row.Total,
        Month: row.Month,
        Year: row.Year,
        owner
      });
    } catch (err) {
      console.error(`❌ Firestore 업로드 실패 (Destination: ${row.Destination}, Date: ${row.Date}):`, err);
    }
  }

  console.log("✅ PerDiem Firestore 업로드 완료");
}