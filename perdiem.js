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

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const db = admin.firestore();

  const flightRows = rows.filter(r => r[6] && r[9] && r[6] !== r[9]);
  const QUICK_DESTS = ["NRT", "HKG", "DAC"];

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity, , From, , STDZ, To, , STAZ] = row;

    let DateFormatted = convertDate(DateStr);
    if (!DateFormatted || !DateFormatted.includes(".")) {
      DateFormatted = i > 0 ? convertDate(flightRows[i-1][0]) 
        : `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")}`;
    }

    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0] || String(now.getFullYear());
    const Month = (dfParts[1] || "01").padStart(2,"0");

    let Rate = From === "ICN" ? 0 : PERDIEM_RATE[From] || 3;
    let riDate = null, roDate = null;

    // ===== 귀국편 (To === ICN) =====
    if (To === "ICN" && From !== "ICN") {
      roDate = parseHHMMOffset(STDZ, DateFormatted);

      if (i === 0) {
        const curMonthNum = Number(Month);
        const prevMonthNum = curMonthNum - 1 >= 1 ? curMonthNum - 1 : 12;
        const prevMonth = String(prevMonthNum).padStart(2,"0");
        const prevYear = prevMonthNum === 12 ? String(Number(Year)-1) : Year;

        const prevSnapshot = await db.collection("Perdiem")
          .where("owner","==",owner)
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
      } else {
        const prevRow = flightRows[i-1];
        riDate = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
      }
    }
    // ===== 출발편 (ICN → 해외 도착) =====
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
      const prevRow = flightRows[i-1];
      if (prevRow[6] === "ICN" && prevRow[9] === From) {
        const prevRI = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
        if (prevRI instanceof Date && !isNaN(prevRI)) {
          isQuickTurnReturn = true;
          riDate = prevRI;
          if (!DateStr || !DateStr.trim()) DateFormatted = convertDate(prevRow[0]);
        }
      }
    }

    // ===== Per Diem 계산 =====
    const riValid = riDate instanceof Date && !isNaN(riDate) ? riDate : null;
    const roValid = roDate instanceof Date && !isNaN(roDate) ? roDate : null;

    let { StayHours, Total } = calculatePerDiem(riValid, roValid, Rate);

    if (From === "ICN") StayHours = "0:00";
    if (isQuickTurnReturn) {
      Total = 33;
      Rate = 33;
    }

    // ===== 🚀 교통비 추가 =====
    const TransportFee = From !== To ? 7000 : 0;

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
      TransportFee, // 추가
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

export async function uploadPerDiemFirestore(perdiemList) {
  const owner = process.env.FIRESTORE_ADMIN_UID || process.env.firestoreAdminUid || "";

  if (!Array.isArray(perdiemList) || !owner) {
    console.warn("❌ uploadPerDiemFirestore: 잘못된 입력 또는 FIRESTORE_ADMIN_UID 누락");
    return;
  }

  if (!admin.apps.length)
    admin.initializeApp({ credential: admin.credential.applicationDefault() });

  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  console.log(`🚀 Firestore 업로드 시작: ${perdiemList.length}건 (owner=${owner})`);

  let successCount = 0;
  let failCount = 0;

  for (const row of perdiemList) {
    try {
      if (!row || !row.Date || !row.Destination) continue;

      // normalize From and build data
      const rawFrom = row.From ?? row.FROM ?? "";
      const normalizedFrom = String(rawFrom).trim().toUpperCase();
      const data = { ...row, owner };

      // Debug log to inspect incoming values (remove in production if noisy)
      console.log(`DEBUG: From="${rawFrom}" -> "${normalizedFrom}", Date=${row.Date}, Dest=${row.Destination}`);

      // ICN 출발편 강제 적용 (보다 강건한 비교)
      if (normalizedFrom === "ICN") {
        data.StayHours = "0:00";
        data.Total = 0;
        data.TransportFee = 7000;
        console.log(`INFO: Applied ICN defaults for ${row.Date} ${row.Destination}`);
      }

      // 기존 문서 삭제 (Date + Destination + owner 기준)
      const snapshot = await collection
        .where("Destination", "==", row.Destination)
        .where("Date", "==", row.Date)
        .where("owner", "==", owner)
        .get();

      if (!snapshot.empty) {
        for (const doc of snapshot.docs) {
          await collection.doc(doc.id).delete();
          console.log(`🗑️ 기존 문서 삭제: ${row.Destination}, ${row.Date}`);
        }
      }

      // 새 문서 저장
      await collection.add(data);
      console.log(`✅ 저장 완료: ${rawFrom} → ${row.Destination}, ${row.Date}`);
      successCount++;
    } catch (err) {
      console.error(`❌ 업로드 실패 (${row.From} → ${row.Destination}, ${row.Date}):`, err);
      failCount++;
    }
  }

  console.log(`✅ Firestore 업로드 완료: ${successCount}건 성공, ${failCount}건 실패`);
}
