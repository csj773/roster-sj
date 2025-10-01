// ========================= perdiem.js =========================
import fs from "fs";
import admin from "firebase-admin";
import { PERDIEM_RATE } from "./perdiemRate.js";
import { parseHHMMOffset, convertDate, calculatePerDiem } from "./flightTimeUtils.js";

// ------------------- Roster.json → PerDiem 리스트 -------------------
export async function generatePerDiemList(rosterJsonPath, userId) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);

  rows.sort((a, b) => new Date(convertDate(a[0])) - new Date(convertDate(b[0])));

  const perdiemList = [];
  const now = new Date();
  const QUICK_DESTS = ["NRT", "HKG", "DAC"];

  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const flightRows = rows.filter(r => r[6] && r[9] && r[6] !== r[9]);

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

      // 이번달 첫편 → 이전달 귀국편 처리
      if (i === 0) {
        const curMonthNum = Number(Month);
        const prevMonthNum = curMonthNum - 1 >= 1 ? curMonthNum - 1 : 12;
        const prevMonth = String(prevMonthNum).padStart(2,"0");
        const prevYear = prevMonthNum === 12 ? String(Number(Year)-1) : Year;

        const prevSnapshot = await db.collection("Perdiem")
          .where("owner","==",userId)
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
        // 바로 이전편 도착시간을 RI로
        const prevRow = flightRows[i-1];
        riDate = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
      }
    }

    // ===== 출발편 (From === ICN → 해외 도착) =====
    else if (From === "ICN") {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
    }

    // ===== 해외출발편 (From ≠ ICN, To ≠ ICN) =====
    else {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // Quick Turn 귀국편 처리
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

    const riValid = riDate instanceof Date && !isNaN(riDate) ? riDate : null;
    const roValid = roDate instanceof Date && !isNaN(roDate) ? roDate : null;

    let { StayHours, Total } = calculatePerDiem(riValid, roValid, Rate);

    // 출발편 (ICN출발) StayHours = 0
    if (From === "ICN") StayHours = "0:00";

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

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath) {
  const header = "Date,Activity,From,Destination,RI,RO,StayHours,Rate,Total,Month,Year\n";
  const rows = perdiemList.map(e =>
    `${e.Date},${e.Activity},${e.From},${e.Destination},${e.RI},${e.RO},${e.StayHours},${e.Rate},${e.Total},${e.Month},${e.Year}`
  );
  fs.writeFileSync(outputPath, header + rows.join("\n"), "utf-8");
  console.log(`✅ CSV 저장 완료: ${outputPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, userId) {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const batch = db.batch();

  perdiemList.forEach(e => {
    const ref = db.collection("Perdiem").doc();
    batch.set(ref, { ...e, owner: userId });
  });

  await batch.commit();
  console.log(`✅ Firestore 업로드 완료 (${perdiemList.length}건)`);
}