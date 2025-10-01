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

  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) return input;

  const now = new Date();
  const year = now.getFullYear();

  // 월 문자열 매핑
  const monthMap = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };

  let month, dayStr;

  if (monthMap[parts[0]]) {
    // 입력이 "Sep 29" 같은 형식일 때
    month = monthMap[parts[0]];
    dayStr = parts[1].padStart(2, "0");
  } else {
    // 입력이 "Mon 29" 같이 요일만 있을 때
    month = String(now.getMonth() + 1).padStart(2, "0");
    dayStr = parts[1].padStart(2, "0");
  }

  return `${year}.${month}.${dayStr}`;
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

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const db = admin.firestore();

  const flightRows = rows.filter(r => r[6] && r[9] && r[6] !== r[9]);

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity, , From, , STDZ, To, , STAZ] = row;
    let DateFormatted = convertDate(DateStr);

    // --- DateRaw 누락 시 이전편의 Date 사용
    if ((!DateFormatted || DateFormatted === "NaN.undefined.NaN") && i > 0) {
      const prevRow = flightRows[i - 1];
      const prevDate = convertDate(prevRow[0]);
      if (prevDate) DateFormatted = prevDate;
    }
    if (!DateFormatted) {
      const now = new Date();
      DateFormatted = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")}`;
    }

    // --- Month/Year은 현재 행의 DateFormatted에서 계산
    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0];
    const Month = dfParts[1].padStart(2, "0");

    // Quick turn 대상 공항
    const QUICK_DESTS = ["NRT", "HKG", "DAC"];

    // 기본 Rate
    const defaultRate = From === "ICN" ? 0 : PERDIEM_RATE[From] || 3;
    let Rate = defaultRate;
    let riDate = null;
    let roDate = null;

    // ----------------- 이전달 귀국편 처리 (첫 행이면서 귀국편인 경우)
    if (i === 0 && To === "ICN" && From !== "ICN") {
      const curMonthNum = Number(Month);
      const prevMonthNum = curMonthNum - 1 >= 1 ? curMonthNum - 1 : 12;
      const prevMonth = String(prevMonthNum).padStart(2, "0");
      const prevYear = prevMonthNum === 12 ? String(Number(Year) - 1) : Year;

      const prevSnapshot = await db.collection("Perdiem")
        .where("userId", "==", userId)
        .where("Month", "==", prevMonth)
        .where("Year", "==", prevYear)
        .where("Destination", "==", From)
        .orderBy("Date", "desc")
        .limit(1)
        .get();

      if (!prevSnapshot.empty) {
        const prevDoc = prevSnapshot.docs[0].data();
        if (prevDoc.RO) riDate = new Date(prevDoc.RO);
      }

      roDate = parseHHMMOffset(STDZ, DateFormatted);
    } else {
      if (Rate > 0) {
        for (let j = i - 1; j >= 0; j--) {
          const prevRow = flightRows[j];
          if (prevRow[6] && prevRow[9] && prevRow[6] !== prevRow[9]) {
            const prevDateStr = convertDate(prevRow[0]);
            const tempRI = parseHHMMOffset(prevRow[11], prevDateStr);
            if (tempRI instanceof Date && !isNaN(tempRI)) {
              riDate = tempRI;
              break;
            }
          }
        }
      }
      if (!riDate) riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // --- Quick turn 귀국편 여부 확인
    let isQuickTurnReturn = false;
    if (To === "ICN" && QUICK_DESTS.includes(From) && i > 0) {
      const prevRow = flightRows[i - 1];
      const prevFrom = prevRow[6], prevTo = prevRow[9];
      if (prevFrom === "ICN" && prevTo === From) {
        const prevDate = convertDate(prevRow[0]);
        const prevRI = parseHHMMOffset(prevRow[11], prevDate);
        const curRO = parseHHMMOffset(STDZ, DateFormatted);
        if (prevRI instanceof Date && !isNaN(prevRI) && curRO instanceof Date && !isNaN(curRO)) {
          const diffHours = (curRO - prevRI) / 1000 / 3600;
          if (diffHours <= 8 && diffHours > 0) {
            isQuickTurnReturn = true;
            riDate = prevRI;
            if (!DateStr || !DateStr.trim()) {
              DateFormatted = prevDate;
            }
          }
        }
      }
    }

    const riValid = riDate instanceof Date && !isNaN(riDate) ? riDate : null;
    const roValid = roDate instanceof Date && !isNaN(roDate) ? roDate : null;
    const { StayHours, Total: baseTotal } = calculatePerDiem(riValid, roValid, Rate);

    // --- Quick turn 귀국편이면 Total, Rate 강제 33 USD
    let Total = baseTotal;
    if (isQuickTurnReturn) {
      Total = 33;
      Rate = 33;
    }

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

// ------------------- CSV 저장 (Flight 전용) -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  if (!Array.isArray(perdiemList)) {
    console.warn("❌ savePerDiemCSV: perdiemList가 배열이 아닙니다.");
    return;
  }

  const headers = ["Date","Activity","From","RI","Destination","RO","StayHours","Rate","Total"];
  const csvRows = [headers.join(",")];

  for (const row of perdiemList) {
    if (!row || !row.From || !row.Destination || row.From === row.Destination) continue;
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