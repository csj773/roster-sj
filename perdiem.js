// ========================= perdiem.js (최신 통합 패치본) =========================
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
    dayStr = parts[0].padStart(2, "0");
  }

  return `${year}.${month}.${dayStr}`;
}

// ------------------- HHMM±Offset → Date 변환 -------------------
function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const baseParts = baseDateStr.split(".");
  let date = new Date(
    Number(baseParts[0]), Number(baseParts[1]) - 1, Number(baseParts[2]),
    Number(hh), Number(mm)
  );
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

// ------------------- PerDiem 계산 -------------------
function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate)
    return { StayHours: "0:00", Total: 0 };
  const diff = (roDate - riDate) / 1000 / 3600;
  const total = Math.round(diff * rate * 100) / 100;
  return { StayHours: hourToTimeStr(diff), Total: total };
}

// ------------------- Roster.json → PerDiem 리스트 -------------------
export async function generatePerDiemList(rosterJsonPath, owner) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);
  rows.sort((a, b) => new Date(convertDate(a[0])) - new Date(convertDate(b[0])));

  if (!admin.apps.length)
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const perdiemList = [];
  const QUICK_DESTS = ["NRT", "HKG", "DAC"];

  const flightRows = rows.filter(r => {
    const activity = (r[4] || "").trim().toUpperCase();
    const from = (r[6] || "").trim();
    const to = (r[9] || "").trim();
    return activity.startsWith("YP") && from && to && from !== to;
  });

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity,, FromRaw,, STDZ, ToRaw,, STAZ] = row;
    const From = FromRaw.trim();
    const To = ToRaw.trim();
    let DateFormatted = convertDate(DateStr);
    const now = new Date();
    if (!DateFormatted || !DateFormatted.includes("."))
      DateFormatted = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;

    const [Year, Month] = DateFormatted.split(".");
    let Rate = PERDIEM_RATE[To] || 3;
    let riDate = null, roDate = null;
    let isQuickTurnReturn = false;

    // --- 첫 해외 출발편이면 Firestore에서 직전 RO 연결 ---
    if (i === 0 && From !== "ICN") {
      const prevSnap = await db
        .collection("Perdiem")
        .where("To", "==", From)
        .where("owner", "==", owner)
        .orderBy("Date", "desc")
        .limit(1)
        .get();
      if (!prevSnap.empty) {
        const prev = prevSnap.docs[0].data();
        riDate = prev.RO ? new Date(prev.RO) : null;
        console.log(`🔗 Linked previous RO from Firestore: ${prev.Activity} (${prev.To}→${prev.From})`);
      }
    }

    // --- 출발이 ICN인 경우 ---
    if (From === "ICN") {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
    }
    // --- 귀국편 (To === ICN) ---
    else if (To === "ICN") {
      roDate = parseHHMMOffset(STDZ, DateFormatted);
      if (i > 0) riDate = parseHHMMOffset(flightRows[i - 1][11], convertDate(flightRows[i - 1][0]));
    }
    // --- 해외 ↔ 해외 ---
    else {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // --- Quick Turn 감지 ---
    if (To === "ICN" && QUICK_DESTS.includes(From) && i > 0) {
      const prev = flightRows[i - 1];
      if (prev[6] === "ICN" && prev[9] === From) {
        isQuickTurnReturn = true;
        riDate = parseHHMMOffset(prev[11], convertDate(prev[0]));
      }
    }

    const { StayHours, Total } = calculatePerDiem(riDate, roDate, Rate);

    const TransportFee = 14000; // 일률적 적용

    perdiemList.push({
      Date: DateFormatted, Activity, From, Destination: To,
      RI: riDate ? riDate.toISOString() : "",
      RO: roDate ? roDate.toISOString() : "",
      StayHours, Rate, Total, TransportFee,
      Month, Year, owner
    });
  }

  // 🔹 중복제거
  const seen = new Set();
  const uniqueList = [];
  for (const item of perdiemList) {
    const key = `${item.Date}_${item.Activity}_${item.owner}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueList.push(item);
    }
  }

  console.log(`✅ PerDiem 리스트 생성 완료 (${uniqueList.length}건)`);
  return uniqueList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  const header = "Date,Activity,From,Destination,RI,RO,StayHours,Rate,Total,TransportFee,Month,Year\n";
  const rows = perdiemList.map(e =>
    `${e.Date},${e.Activity},${e.From},${e.Destination},${e.RI},${e.RO},${e.StayHours},${e.Rate},${e.Total},${e.TransportFee},${e.Month},${e.Year}`
  );
  const full = path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, header + rows.join("\n"), "utf-8");
  console.log(`✅ CSV 저장 완료: ${full}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList) {
  const owner = process.env.FIRESTORE_ADMIN_UID || process.env.firestoreAdminUid || "";
  if (!Array.isArray(perdiemList) || !owner) return;

  if (!admin.apps.length)
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const ref = db.collection("Perdiem");

  for (const item of perdiemList) {
    const docId = `${item.Year}${item.Month}${item.Date.replace(/\./g, "")}_${item.Destination}`;
    await ref.doc(docId).set(item, { merge: true });
  }

  console.log(`✅ Firestore 업로드 완료 (${perdiemList.length}건)`);
}