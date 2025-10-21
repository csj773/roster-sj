// ========================= perdiem.js (패치 통합본 vFinal) =========================
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

  const QUICK_DESTS = ["NRT", "HKG", "DAC"];

  // ===== flightRows 필터: Activity가 YP로 시작하고 From != To =====
  const flightRows = rows.filter(r => {
    const activity = (r[4] || "").trim().toUpperCase();
    const from = (r[6] || "").trim();
    const to = (r[9] || "").trim();
    return activity.startsWith("YP") && from && to && from !== to;
  });

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity,, FromRaw,, STDZ, ToRaw,, STAZ] = row;

    const From = FromRaw?.trim() || "UNKNOWN";
    const To = ToRaw?.trim() || "UNKNOWN";

    // DateFormatted 계산 (빈칸일 경우 이전 행 날짜 또는 오늘)
    let DateFormatted = convertDate(DateStr);
    if (!DateFormatted || !DateFormatted.includes(".")) {
      DateFormatted = i > 0 ? convertDate(flightRows[i-1][0])
        : `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")}`;
    }

    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0] || String(now.getFullYear());
    const Month = (dfParts[1] || "01").padStart(2,"0");

    // 기본 설정
    let Rate = From === "ICN" ? 0 : PERDIEM_RATE[From] || 3;
    let riDate = null, roDate = null;
    let StayHours = "0:00", Total = 0, TransportFee = 7000;

    // ===== 첫 편이 해외 출발(From !== ICN)일 때 이전 RO 연결 시도 =====
    if (i === 0 && From !== "ICN") {
      // 최근 Perdiem 중 Destination이 이번 From인 문서를 찾아 RO 사용
      try {
        const prevSnapshot = await db.collection("Perdiem")
          .where("owner", "==", owner)
          .where("Destination", "==", From)
          .orderBy("Date", "desc")
          .limit(1)
          .get();
        if (!prevSnapshot.empty) {
          const prevDoc = prevSnapshot.docs[0].data();
          if (prevDoc && prevDoc.RO) {
            const prevRODate = new Date(prevDoc.RO);
            if (!isNaN(prevRODate)) riDate = prevRODate;
          }
        }
      } catch (err) {
        // Firestore 접근 실패해도 계속 (예: 로컬 테스트)
        // console.warn("prevSnapshot error", err);
      }
    }

    // ===== 구분: ICN 출발 / 해외→ICN 귀국 / 해외↔해외 =====
    if (From === "ICN") {
      // ICN 출발 해외편: RI만 존재, per diem 없음
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      StayHours = "0:00";
      Total = 0;
      Rate = 0;
      TransportFee = 7000;
    }
    else if (To === "ICN" && From !== "ICN") {
      // 귀국편: RO 계산, RI는 이전 행 or firestore에서 가져온 값
      roDate = parseHHMMOffset(STDZ, DateFormatted);

      if (!riDate) {
        if (i > 0) {
          const prevRow = flightRows[i-1];
          riDate = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
        } else {
          // 이미 시도했음(위의 첫편 처리) — riDate may be from prevSnapshot
        }
      }
    } else {
      // 해외 출발 ↔ 해외 도착 (both non-ICN)
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // ===== Quick Turn 귀국편 처리 (NRT/HKG/DAC 등) =====
    let isQuickTurnReturn = false;
    if (To === "ICN" && QUICK_DESTS.includes(From) && i > 0) {
      const prevRow = flightRows[i-1];
      if (prevRow && prevRow[6] === "ICN" && prevRow[9] === From) {
        const prevRI = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
        if (prevRI instanceof Date && !isNaN(prevRI)) {
          isQuickTurnReturn = true;
          riDate = prevRI;
          // 날짜 빈칸 보정
          if (!DateStr || !DateStr.trim()) DateFormatted = convertDate(prevRow[0]);
        }
      }
    }

    // ===== Per Diem 계산 (ICN 출발은 이미 0으로 처리) =====
    const riValid = riDate instanceof Date && !isNaN(riDate) ? riDate : null;
    const roValid = roDate instanceof Date && !isNaN(roDate) ? roDate : null;

    // Only compute per diem when not ICN->외항 (we set Rate/Total above for ICN departures)
    if (!(From === "ICN")) {
      const pd = calculatePerDiem(riValid, roValid, Rate);
      StayHours = pd.StayHours;
      Total = pd.Total;
    }

    // Quick turn override
    if (isQuickTurnReturn) {
      Total = 33;
      Rate = 33;
      TransportFee = 14000;
    }

    // ===== 유효성: 반드시 From, To, Activity(YP) 존재해야 저장 (안정성) =====
    const activityNorm = (Activity || "").toString().trim();
    const isYP = activityNorm.toUpperCase().startsWith("YP");
    const hasValidRoute = From && To && From !== To;

    if (!isYP || !hasValidRoute) {
      // skip invalid rows (safety)
      continue;
    }

    perdiemList.push({
      Date: DateFormatted,
      Activity: activityNorm,
      From,
      Destination: To,
      RI: riValid ? riValid.toISOString() : "",
      RO: roValid ? roValid.toISOString() : "",
      StayHours,
      Rate,
      Total,
      TransportFee,
      Month,
      Year,
      owner
    });
  }

  // ===== 중복 제거: Date + Activity + owner 기준 (먼저 나온 항목 유지) =====
  const uniqueMap = new Map();
  for (const item of perdiemList) {
    const key = `${item.Date}_${item.Activity}_${owner}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, item);
  }
  const finalList = Array.from(uniqueMap.values());

  return finalList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  if (!Array.isArray(perdiemList)) return;

  const header = "Date,Activity,From,Destination,RI,RO,StayHours,Rate,Total,TransportFee,Month,Year,owner\n";
  const rows = perdiemList.map(e =>
    `${e.Date},${e.Activity},${e.From},${e.Destination},${e.RI},${e.RO},${e.StayHours},${e.Rate},${e.Total},${e.TransportFee},${e.Month},${e.Year},${e.owner}`
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

// ------------------- Firestore 업로드 (중복 삭제 후 하나만 남김) -------------------
export async function uploadPerDiemFirestore(perdiemList) {
  const owner = process.env.FIRESTORE_ADMIN_UID || process.env.firestoreAdminUid || "";
  if (!Array.isArray(perdiemList) || !owner) {
    console.warn("uploadPerDiemFirestore: invalid input or owner missing");
    return;
  }

  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });

  const db = admin.firestore();
  const collectionRef = db.collection("Perdiem");

  for (const item of perdiemList) {
    // 중복 조회: Date + Activity + owner
    const snapshot = await collectionRef
      .where("owner", "==", owner)
      .where("Date", "==", item.Date)
      .where("Activity", "==", item.Activity)
      .get();

    if (!snapshot.empty) {
      // 삭제 — 하나는 남기고(첫 doc) 나머지 삭제, 그 후 첫 doc에 덮어쓰기
      const docs = snapshot.docs;
      const firstDoc = docs[0];
      for (let j = 1; j < docs.length; j++) {
        await collectionRef.doc(docs[j].id).delete();
      }
      await collectionRef.doc(firstDoc.id).set({ owner, ...item }, { merge: true });
    } else {
      // 신규 업로드: docId는 Date+Activity+owner 형식으로 생성 (중복 조건과 일치)
      const docId = `${item.Date.replace(/\./g, "")}_${item.Activity}_${owner}`;
      await collectionRef.doc(docId).set({ owner, ...item });
    }
  }

  console.log(`✅ Firestore 업로드 완료 (${perdiemList.length}건, 중복 제거 적용)`);
}