
// ========================= perdiem.js 최신 패치 =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// 공항별 PerDiem
export const PERDIEM_RATE = {
  LAX: 3.42, EWR: 3.44, HNL: 3.01, FRA: 3.18, BCN: 3.11,
  BKK: 2.14, DAD: 2.01, SFO: 3.42, OSL: 3.24,
  DAC: 33, NRT: 33, HKG: 33
};

// 문자열 날짜 → YYYY.MM.DD
export function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) return input;

  const now = new Date();
  const year = now.getFullYear();
  const monthMap = { Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
                     Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12" };
  
  let month = monthMap[parts[0]] || String(now.getMonth()+1).padStart(2,"0");
  const dayStr = parts[1].padStart(2,"0");
  return `${year}.${month}.${dayStr}`;
}

// HHMM±Offset → Date
function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const [year, month, day] = baseDateStr.split(".");
  let date = new Date(Number(year), Number(month)-1, Number(day), Number(hh), Number(mm));
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

// PerDiem 계산
function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) return { StayHours: "0:00", Total: 0 };
  const diffHours = (roDate - riDate) / 1000 / 3600;
  const total = Math.round(diffHours * rate * 100) / 100;
  return { StayHours: hourToTimeStr(diffHours), Total: total };
}

// Roster JSON → PerDiem 리스트
export async function generatePerDiemList(rosterJsonPath, owner) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath,"utf-8"));
  const rows = raw.values.slice(1).filter(r => r[6] && r[9] && r[6] !== r[9]);
  rows.sort((a,b) => new Date(convertDate(a[0])) - new Date(convertDate(b[0])));

  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const QUICK_DESTS = ["NRT","HKG","DAC"];
  const perdiemList = [];
  const now = new Date();

  for (let i=0;i<rows.length;i++) {
    const row = rows[i];
    const [DateStr,, , , Activity, , From, , STDZ, To, , STAZ] = row;
    let DateFormatted = convertDate(DateStr) || `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")}`;
    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0];
    const Month = (dfParts[1] || "01").padStart(2,"0");
    let Rate = From === "ICN" ? 0 : PERDIEM_RATE[From] || 3;

    // RI/RO 계산
    let riDate = null, roDate = null;
    if (From === "ICN") {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
    } else {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // Quick Turn
    let isQuickTurnReturn = false;
    if (To === "ICN" && QUICK_DESTS.includes(From) && i>0) {
      const prevRow = rows[i-1];
      if (prevRow[6]==="ICN" && prevRow[9]===From) {
        const prevRI = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
        if (prevRI instanceof Date && !isNaN(prevRI)) {
          isQuickTurnReturn = true;
          riDate = prevRI;
          if (!DateStr || !DateStr.trim()) DateFormatted = convertDate(prevRow[0]);
        }
      }
    }

    // === PerDiem 계산 ===
    let StayHours = "0:00", Total = 0; // 기본값 초기화
    const riValid = riDate instanceof Date && !isNaN(riDate) ? riDate : null;
    const roValid = roDate instanceof Date && !isNaN(roDate) ? roDate : null;

    if (From === "ICN") {
      StayHours = "0:00";
      Total = 0;
    } else if (isQuickTurnReturn) {
      StayHours = riValid && roValid ? hourToTimeStr((roValid - riValid)/3600000) : "0:00";
      Total = 33;
      Rate = 33;
    } else {
      const result = calculatePerDiem(riValid, roValid, Rate);
      StayHours = result.StayHours;
      Total = result.Total;
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

// CSV 저장
export function savePerDiemCSV(perdiemList, outputPath="public/perdiem.csv") {
  const header = "Date,Activity,From,Destination,RI,RO,StayHours,Rate,Total,Month,Year\n";
  const rows = perdiemList.map(e => `${e.Date},${e.Activity},${e.From},${e.Destination},${e.RI},${e.RO},${e.StayHours},${e.Rate},${e.Total},${e.Month},${e.Year}`);
  const fullPath = path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive:true });
  fs.writeFileSync(fullPath, header + rows.join("\n"), "utf-8");
  console.log(`✅ CSV 저장 완료: ${fullPath}`);
}

// Firestore 업로드
export async function uploadPerDiemFirestore(perdiemList) {
  const owner = process.env.firestoreAdminUid || "";
  if (!Array.isArray(perdiemList) || !owner) {
    console.warn("❌ uploadPerDiemFirestore: 잘못된 입력 또는 firestoreAdminUid 누락");
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
        .where("owner","==",owner)
        .get();

      if (!snapshot.empty) {
        for (const doc of snapshot.docs) await collection.doc(doc.id).delete();
      }
      await collection.add({...row, owner});
    } catch(err) {
      console.error(`❌ Firestore 업로드 실패 (${row.Destination}, ${row.Date}):`, err);
    }
  }

  console.log("✅ PerDiem Firestore 업로드 완료");
}
