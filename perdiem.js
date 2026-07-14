// ========================= perdiem.js (패치 통합본: Month = "Oct" 형식) =========================
import fs from "fs";
import path from "path";
import crypto from "crypto";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 PER DIEM -------------------
export const PERDIEM_RATE = {
  LAX: 3.42, EWR: 3.44,IAD: 3.44, HNL: 3.01, FRA: 3.18, BCN: 3.11,
  BKK: 2.14,SIN: 2.14, DAD: 2.01, SFO: 3.42, OSL: 3.24,
  DAC: 33, NRT: 33, HKG: 33
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAME_TO_NUMBER = Object.fromEntries(MONTH_NAMES.map((name, index) => [name.toLowerCase(), index + 1]));
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TRANSPORT_FEE_PER_FLIGHT = 7000;

// ------------------- Date 변환 -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) return input;

  const now = new Date();
  const year = now.getUTCFullYear();

  const monthMap = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };

  let month, dayStr;
  if (monthMap[parts[0]]) {
    month = monthMap[parts[0]];
    dayStr = parts[1].padStart(2, "0");
  } else {
    month = String(now.getUTCMonth() + 1).padStart(2, "0");
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
  const dayOffset = offset ? Number(offset) : 0;
  return new Date(Date.UTC(
    Number(baseDateParts[0]),
    Number(baseDateParts[1]) - 1,
    Number(baseDateParts[2]) + dayOffset,
    Number(hh),
    Number(mm)
  ));
}

function formatDateDots(year, month, day) {
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

function incrementMonth(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function addMonths(year, month, delta) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function findMonthMatchingWeekday(year, month, day, weekdayToken) {
  const expected = WEEKDAY_INDEX[weekdayToken];
  if (expected === undefined) return null;

  for (const delta of [0, 1, 2, -1]) {
    const candidate = addMonths(year, month, delta);
    const actual = new Date(Date.UTC(candidate.year, candidate.month - 1, day)).getUTCDay();
    if (actual === expected) return candidate;
  }
  return null;
}

function parseRosterDateText(input) {
  if (!input || typeof input !== "string") return null;
  const dayMatch = input.match(/\d{1,2}/);
  if (!dayMatch) return null;

  let explicitMonth = null;
  let weekday = null;
  const tokens = input.match(/\b([A-Za-z]{3,9})\b/g) || [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (MONTH_NAME_TO_NUMBER[key]) {
      explicitMonth = MONTH_NAME_TO_NUMBER[key];
      break;
    }
    if (WEEKDAY_INDEX[key] !== undefined) weekday = key;
  }

  return { day: Number(dayMatch[0]), explicitMonth, weekday };
}

function resolveRosterDateSequence(rows, dateIndex = 0) {
  const resolved = new WeakMap();
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  let lastDay = null;
  let currentDate = null;

  for (const row of rows) {
    const parsed = parseRosterDateText(row[dateIndex]);

    if (parsed) {
      if (parsed.explicitMonth) {
        if (parsed.explicitMonth < month && month - parsed.explicitMonth > 6) year += 1;
        month = parsed.explicitMonth;
      } else if (lastDay !== null && parsed.weekday && parsed.day < lastDay) {
        ({ year, month } = incrementMonth(year, month));
      } else if (parsed.weekday) {
        const matched = findMonthMatchingWeekday(year, month, parsed.day, parsed.weekday);
        if (matched) ({ year, month } = matched);
      }

      currentDate = formatDateDots(year, month, parsed.day);
      lastDay = parsed.day;
    }

    if (currentDate) resolved.set(row, currentDate);
  }

  return resolved;
}

function monthYearFromKst(date, fallbackDateFormatted) {
  const target = date instanceof Date && !isNaN(date) ? new Date(date.getTime() + KST_OFFSET_MS) : null;
  if (target) {
    return {
      Year: String(target.getUTCFullYear()),
      Month: MONTH_NAMES[target.getUTCMonth()] || "Unknown",
    };
  }

  const dfParts = String(fallbackDateFormatted || "").split(".");
  const monthIndex = Number(dfParts[1] || "1") - 1;
  return {
    Year: dfParts[0] || String(new Date().getUTCFullYear()),
    Month: MONTH_NAMES[monthIndex] || "Unknown",
  };
}

function monthForSheet(month) {
  if (typeof month === "number") return month;
  const monthNum = MONTH_NAME_TO_NUMBER[String(month || "").toLowerCase()];
  return monthNum || month || "";
}

// ------------------- PerDiem 계산 -------------------
function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) return { StayHours: "0:00", Total: 0 };
  const diffHours = (roDate - riDate) / 1000 / 3600;
  const total = Math.round(diffHours * rate * 100) / 100;
  return { StayHours: hourToTimeStr(diffHours), Total: total };
}

// ------------------- Roster.json → PerDiem 리스트 -------------------
export async function generatePerDiemList(rosterJsonPath, owner) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);
  const resolvedDates = resolveRosterDateSequence(rows);
  const resolvedDateForRow = (row) => resolvedDates.get(row) || convertDate(row[0]);

  const perdiemList = [];
  const now = new Date();

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const db = admin.firestore();

  const QUICK_DESTS = ["NRT", "HKG", "DAC"];

  // ===== flightRows 필터링 =====
  const flightRows = rows.filter(r => {
    const activity = (r[4] || "").trim().toUpperCase();
    const from = (r[6] || "").trim();
    const to = (r[9] || "").trim();
    return activity && !["OFF", "REST", "RSV"].includes(activity) && from && to;
  });

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity,, FromRaw,, STDZ, ToRaw,, STAZ] = row;

    const From = FromRaw?.trim() || "UNKNOWN";
    const To = ToRaw?.trim() || "UNKNOWN";

    let DateFormatted = resolvedDateForRow(row);
    if (!DateFormatted || !DateFormatted.includes(".")) {
      DateFormatted = i > 0 ? resolvedDateForRow(flightRows[i - 1])
        : `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, "0")}.${String(now.getUTCDate()).padStart(2, "0")}`;
    }

    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0] || String(now.getUTCFullYear());
    const monthNum = (dfParts[1] || "01").padStart(2, "0");

    let Rate = From === "ICN" ? 0 : PERDIEM_RATE[From] || 3;
    let riDate = null, roDate = null;

    // ===== 귀국편 =====
    if (To === "ICN" && From !== "ICN") {
      roDate = parseHHMMOffset(STDZ, DateFormatted);

      if (i === 0) {
        const curMonthNum = Number(monthNum);
        const prevMonthNum = curMonthNum - 1 >= 1 ? curMonthNum - 1 : 12;
        const prevMonth = MONTH_NAMES[prevMonthNum - 1] || "Unknown";
        const prevYear = prevMonthNum === 12 ? String(Number(Year) - 1) : Year;

        const prevSnapshot = await db.collection("Perdiem")
          .where("owner", "==", owner)
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
      } else {
        const prevRow = flightRows[i - 1];
        riDate = parseHHMMOffset(prevRow[11], resolvedDateForRow(prevRow));
      }
    }
    // ===== 출발편 (ICN → 해외) =====
    else if (From === "ICN") {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
    }
    // ===== 해외 → 해외 =====
    else {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // ===== Quick Turn 귀국편 =====
    let isQuickTurnReturn = false;
    if (To === "ICN" && QUICK_DESTS.includes(From) && i > 0) {
      const prevRow = flightRows[i - 1];
      if (prevRow[6] === "ICN" && prevRow[9] === From) {
        const prevRI = parseHHMMOffset(prevRow[11], resolvedDateForRow(prevRow));
        if (prevRI instanceof Date && !isNaN(prevRI)) {
          isQuickTurnReturn = true;
          riDate = prevRI;
          if (!DateStr || !DateStr.trim()) DateFormatted = resolvedDateForRow(prevRow);
        }
      }
    }

    // ===== Per Diem 계산 =====
    const riValid = riDate instanceof Date && !isNaN(riDate) ? riDate : null;
    const roValid = roDate instanceof Date && !isNaN(roDate) ? roDate : null;

    let { StayHours, Total } = calculatePerDiem(riValid, roValid, Rate);

    if (From === "ICN") {
      StayHours = "0:00";
      Rate = 0;
      Total = 0;
    }
    if (isQuickTurnReturn) {
      Total = 33;
      Rate = 33;
    }

    let assignedDate = roValid;
    if (From === "ICN" && To !== "ICN") {
      const pairedReturnRow = flightRows.slice(i + 1).find(nextRow => (
        (nextRow[6] || "").trim() === To &&
        (nextRow[9] || "").trim() === "ICN"
      ));
      if (pairedReturnRow) {
        const pairedReturnDate = resolvedDateForRow(pairedReturnRow);
        assignedDate = parseHHMMOffset(pairedReturnRow[8], pairedReturnDate);
      }
    }
    const assigned = monthYearFromKst(assignedDate, DateFormatted);

    // ===== 교통비 =====
    const TransportFee = TRANSPORT_FEE_PER_FLIGHT;

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
      TransportFee,
      Month: assigned.Month,
      Year: assigned.Year
    });
  }

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  if (!Array.isArray(perdiemList)) return;

  const header = "Date,Activity,From,Destination,RI,RO,StayHours,Rate,Total,TransportFee,Month,Year\n";
  const rows = perdiemList.map(e =>
    `${e.Date},${e.Activity},${e.From},${e.Destination},${e.RI},${e.RO},${e.StayHours},${e.Rate},${e.Total},${e.TransportFee},${e.Month},${e.Year}`
  );

  try {
    const fullPath = path.join(process.cwd(), outputPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, header + rows.join("\n"), "utf-8");
    console.log(`✅ CSV 저장 완료: ${fullPath}`);
  } catch (err) {
    console.error("❌ CSV 저장 실패:", err);
  }
}

function buildPerDiemSheetKey(item) {
  return [
    item.Date,
    item.Activity,
    item.From,
    item.Destination,
    item.RI,
    item.RO,
  ].join("||");
}

function randomSheetId() {
  return crypto.randomBytes(4).toString("hex");
}

function uniqueSheetId(usedIds) {
  let id = randomSheetId();
  while (usedIds.has(id)) id = randomSheetId();
  usedIds.add(id);
  return id;
}

// ------------------- Google Sheets append -------------------
export async function appendPerDiemGoogleSheet(perdiemList, sheetsApi, spreadsheetId, sheetName = "Perdiem") {
  if (!Array.isArray(perdiemList) || perdiemList.length === 0 || !sheetsApi || !spreadsheetId) return;

  const existing = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:M`,
  }).catch(err => {
    if (err.code === 400) console.warn(`⚠️ Google Sheets ${sheetName} 읽기 실패, append만 시도:`, err.message);
    else throw err;
    return { data: { values: [] } };
  });

  const existingRows = existing.data.values || [];
  const dataRows = existingRows[0]?.[0] === "ID" ? existingRows.slice(1) : existingRows;
  const usedIds = new Set(dataRows.map(row => row[0]).filter(Boolean));
  const existingKeys = new Set(dataRows.map(row => buildPerDiemSheetKey({
    Date: row[1] || "",
    Activity: row[2] || "",
    From: row[3] || "",
    Destination: row[4] || "",
    RI: row[5] || "",
    RO: row[6] || "",
  })));

  const rows = perdiemList
    .filter(item => !existingKeys.has(buildPerDiemSheetKey(item)))
    .map(item => [
      uniqueSheetId(usedIds),
      item.Date,
      item.Activity,
      item.From,
      item.Destination,
      item.RI,
      item.RO,
      item.StayHours,
      item.Rate,
      item.Total,
      item.TransportFee,
      monthForSheet(item.Month),
      item.Year,
    ]);

  if (rows.length === 0) {
    console.log(`✅ Google Sheets ${sheetName} 추가할 PerDiem 없음`);
    return;
  }

  await sheetsApi.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:M`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
  console.log(`✅ Google Sheets ${sheetName} PerDiem append 완료 (${rows.length}건)`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList) {
  const owner = process.env.FIRESTORE_ADMIN_UID || process.env.firestoreAdminUid || "";
  if (!Array.isArray(perdiemList) || !owner) return;

  if (!admin.apps.length)
    admin.initializeApp({ credential: admin.credential.applicationDefault() });

  const db = admin.firestore();
  const collectionRef = db.collection("Perdiem");

  for (let item of perdiemList) {
    const docId = `${item.Year}${item.Month}${item.Date.replace(/\./g, "")}_${item.Destination}`;
    await collectionRef.doc(docId).set({ owner, ...item });
  }

  console.log(`✅ Firestore 업로드 완료 (${perdiemList.length}건)`);
}
