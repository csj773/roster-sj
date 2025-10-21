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

  const monthMap = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };

  let month, dayStr;
  if (monthMap[parts[0]]) {
    month = monthMap[parts[0]];
    dayStr = parts[1].padStart(2, "0");
  } else {
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
export async function generatePerDiemList(rosterJsonPath, owner) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);
  rows.sort((a, b) => new Date(convertDate(a[0])) - new Date(convertDate(b[0])));

  const perdiemList = [];
  const now = new Date();
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const flightRows = rows.filter(r => r[6] && r[9]);
  const QUICK_DESTS = ["NRT", "HKG", "DAC"];

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity, , From, , STDZ, To, , STAZ] = row;

    // ❌ REST 제외 및 YP 아닌 항공편 제외
    if (!Activity?.startsWith("YP") || Activity === "REST") continue;
    if (From === To) continue;

    let DateFormatted = convertDate(DateStr);
    if (!DateFormatted.includes(".")) {
      DateFormatted =
        i > 0 ? convertDate(flightRows[i - 1][0]) :
        `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
    }

    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0];
    const Month = dfParts[1].padStart(2, "0");

    let Rate = From === "ICN" ? 0 : PERDIEM_RATE[From] || 3;
    let riDate = null, roDate = null;

    // ===== 귀국편 (To === ICN) =====
    if (To === "ICN" && From !== "ICN") {
      roDate = parseHHMMOffset(STDZ, DateFormatted);
      const prevRow = i > 0 ? flightRows[i - 1] : null;
      if (prevRow) riDate = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
    }
    // ===== 출발편 (ICN → 해외) =====
    else if (From === "ICN") {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
    }
    // ===== 해외 출발 ↔ 해외 도착 =====
    else {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // ===== Quick Turn 귀국편 처리 =====
    let isQuickTurnReturn = false;
    if (To === "ICN" && QUICK_DESTS.includes(From) && i > 0) {
      const prevRow = flightRows[i - 1];
      if (prevRow[6] === "ICN" && prevRow[9] === From) {
        const prevRI = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
        if (prevRI instanceof Date && !isNaN(prevRI)) {
          isQuickTurnReturn = true;
          riDate = prevRI;
        }
      }
    }

    // ===== Per Diem 계산 =====
    const { StayHours, Total } = calculatePerDiem(riDate, roDate, Rate);

    // ===== 교통비 =====
    let TransportFee = 7000;
    if (isQuickTurnReturn) TransportFee = 14000;

    perdiemList.push({
      Date: DateFormatted,
      Activity,
      From,
      Destination: To,
      RI: riDate ? riDate.toISOString() : "",
      RO: roDate ? roDate.toISOString() : "",
      StayHours,
      Rate,
      Total,
      TransportFee,
      Month,
      Year
    });
  }

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export async function savePerDiemCSV(perdiemList, outputPath) {
  const filtered = perdiemList.filter(row =>
    row.Activity?.startsWith("YP") && row.Activity !== "REST" && row.From !== row.Destination
  );

  const header = "Date,Activity,From,Destination,RI,RO,StayHours,Rate,Total,TransportFee,Month,Year\n";
  const lines = filtered.map(r =>
    `${r.Date},${r.Activity},${r.From},${r.Destination},${r.RI},${r.RO},${r.StayHours},${r.Rate},${r.Total},${r.TransportFee},${r.Month},${r.Year}`
  );
  fs.writeFileSync(outputPath, header + lines.join("\n"), "utf-8");
  console.log(`💾 CSV saved → ${outputPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList) {
  const owner = process.env.FIRESTORE_ADMIN_UID || process.env.firestoreAdminUid || "";
  if (!Array.isArray(perdiemList) || !owner) return;

  if (!admin.apps.length)
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for (const row of perdiemList) {
    const activity = row.Activity?.trim() || "";
    const from = row.From?.toUpperCase() || "";
    const to = row.Destination?.toUpperCase() || "";

    // ❌ REST 제외 + YP로 시작하지 않거나 From=To 인 경우 저장 안 함
    if (activity === "REST" || !activity.startsWith("YP") || from === to) {
      console.log(`⏭️ 제외: ${activity} (${from} → ${to})`);
      continue;
    }

    const data = { ...row, owner };

    // ✈️ ICN 출발편 강제 세팅
    if (from === "ICN") {
      data.StayHours = "0:00";
      data.Total = 0;
      data.TransportFee = 7000;
    }

    // 중복 방지
    const snapshot = await collection
      .where("Destination", "==", to)
      .where("Date", "==", row.Date)
      .where("owner", "==", owner)
      .get();

    if (!snapshot.empty) {
      for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
    }

    await collection.add(data);
    console.log(`✅ 업로드: ${from} → ${to}, ${row.Date}`);
  }
}
