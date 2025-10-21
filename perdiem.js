// ========================= perdiem.js 통합 패치본 =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

export const PERDIEM_RATE = {
  LAX: 3.42, EWR: 3.44, HNL: 3.01, FRA: 3.18, BCN: 3.11,
  BKK: 2.14, DAD: 2.01, SFO: 3.42, OSL: 3.24,
  DAC: 33, NRT: 33, HKG: 33
};

export function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) return input;
  const now = new Date();
  const year = now.getFullYear();
  const monthMap = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
                     Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12"};
  let month, dayStr;
  if (monthMap[parts[0]]) { month = monthMap[parts[0]]; dayStr = parts[1].padStart(2,"0"); }
  else { month = String(now.getMonth()+1).padStart(2,"0"); dayStr = parts[1].padStart(2,"0"); }
  return `${year}.${month}.${dayStr}`;
}

function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const baseDateParts = baseDateStr.split(".");
  let date = new Date(Number(baseDateParts[0]), Number(baseDateParts[1])-1, Number(baseDateParts[2]), Number(hh), Number(mm));
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) return { StayHours: "0:00", Total: 0 };
  const diffHours = (roDate - riDate)/1000/3600;
  const total = Math.round(diffHours*rate*100)/100;
  return { StayHours: hourToTimeStr(diffHours), Total: total };
}

// ========================= PerDiem 리스트 생성 =========================
export async function generatePerDiemList(rosterJsonPath, owner) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);
  rows.sort((a,b) => new Date(convertDate(a[0])) - new Date(convertDate(b[0])));
  const perdiemList = [];
  const now = new Date();

  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const QUICK_DESTS = ["NRT","HKG","DAC"];

  // ===== 필터: Activity YP + From ≠ To =====
  const flightRows = rows.filter(r => {
    const activity = (r[4]||"").trim().toUpperCase();
    const from = (r[6]||"").trim();
    const to = (r[9]||"").trim();
    return activity.startsWith("YP") && from && to && from !== to;
  });

  for (let i=0; i<flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity,, FromRaw,, STDZ, ToRaw,, STAZ] = row;
    const From = FromRaw?.trim()||"UNKNOWN";
    const To = ToRaw?.trim()||"UNKNOWN";

    let DateFormatted = convertDate(DateStr);
    if (!DateFormatted || !DateFormatted.includes(".")) {
      DateFormatted = i>0 ? convertDate(flightRows[i-1][0])
        : `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")}`;
    }

    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0]||String(now.getFullYear());
    const Month = (dfParts[1]||"01").padStart(2,"0");

    let Rate = From==="ICN"?0:PERDIEM_RATE[From]||3;
    let riDate=null, roDate=null;
    let StayHours="0:00", Total=0, TransportFee=7000;

    // ICN 출발 → 해외 도착
    if (From==="ICN") {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      StayHours="0:00"; Total=0; Rate=0; TransportFee=7000;
    }
    // 해외 출발 → ICN 귀국편
    else if (To==="ICN" && From!=="ICN") {
      roDate = parseHHMMOffset(STDZ, DateFormatted);
      if (i>0) {
        const prevRow = flightRows[i-1];
        riDate = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
      } else {
        const prevSnapshot = await db.collection("Perdiem")
          .where("owner","==",owner)
          .where("Month","==",String(Number(Month)-1).padStart(2,"0"))
          .where("Year","==",Year)
          .where("Destination","==",From)
          .orderBy("Date","desc").limit(1).get();
        if (!prevSnapshot.empty) {
          const prevDoc = prevSnapshot.docs[0].data();
          if (prevDoc.RO) riDate = new Date(prevDoc.RO);
        }
      }
    }
    // 해외 출발 ↔ 해외 도착
    else {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // Quick Turn 처리
    let isQuickTurnReturn=false;
    if (To==="ICN" && QUICK_DESTS.includes(From) && i>0) {
      const prevRow = flightRows[i-1];
      if (prevRow[6]==="ICN" && prevRow[9]===From) {
        const prevRI = parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
        if (prevRI instanceof Date && !isNaN(prevRI)) {
          isQuickTurnReturn=true; riDate=prevRI;
          if (!DateStr || !DateStr.trim()) DateFormatted=convertDate(prevRow[0]);
        }
      }
    }

    const riValid = riDate instanceof Date&&!isNaN(riDate)?riDate:null;
    const roValid = roDate instanceof Date&&!isNaN(roDate)?roDate:null;

    if (!(From==="ICN" && To!=="ICN")) {
      const pd = calculatePerDiem(riValid, roValid, Rate);
      StayHours=pd.StayHours; Total=pd.Total;
    }
    if (isQuickTurnReturn) { Total=33; Rate=33; TransportFee=14000; }

    perdiemList.push({ Date:DateFormatted, Activity, From, Destination:To, RI:riValid?riValid.toISOString():"",
                         RO:roValid?roValid.toISOString():"", StayHours, Rate, Total, TransportFee, Month, Year });
  }

  // 중복 제거: Date+Activity+owner 기준
  const uniqueMap = new Map();
  for (const item of perdiemList) {
    const key = `${item.Date}_${item.Activity}_${owner}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key,item);
  }

  const finalList = Array.from(uniqueMap.values());

  // ================= Firestore 업로드 =================
  const collectionRef = db.collection("Perdiem");
  for (const item of finalList) {
    const docId = `${item.Year}${item.Month}${item.Date.replace(/\./g,"")}_${item.Destination}`;
    await collectionRef.doc(docId).set({ owner, ...item });
  }

  console.log(`✅ Firestore 업로드 완료 (${finalList.length}건)`);
  return finalList;
}