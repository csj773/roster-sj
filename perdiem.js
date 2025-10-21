// ========================= perdiem-YP.js =========================
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
  const monthMap = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };
  let month = monthMap[parts[0]] || String(now.getMonth()+1).padStart(2,"0");
  let day = parts[1].padStart(2,"0");
  return `${year}.${month}.${day}`;
}

function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const baseParts = baseDateStr.split(".");
  let date = new Date(
    Number(baseParts[0]), Number(baseParts[1])-1, Number(baseParts[2]),
    Number(hh), Number(mm)
  );
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) return { StayHours: "0:00", Total: 0 };
  const diffHours = (roDate - riDate)/1000/3600;
  const total = Math.round(diffHours * rate * 100)/100;
  return { StayHours: hourToTimeStr(diffHours), Total: total };
}

export async function generatePerDiemList(rosterJsonPath, owner) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1).filter(r => r.length >= 10);
  const perdiemList = [];
  const now = new Date();

  if (!admin.apps.length)
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const QUICK_DESTS = ["NRT", "HKG", "DAC"];

  // ===== YP + From ≠ To 필터
  const flightRows = rows.filter(r => {
    const activity = (r[4] || "").trim().toUpperCase();
    const from = (r[6] || "").trim();
    const to = (r[9] || "").trim();
    return activity.startsWith("YP") && from && to && from !== to;
  });

  for (let i=0; i<flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity,, FromRaw,, STDZ, ToRaw,, STAZ] = row;
    const From = FromRaw?.trim() || "UNKNOWN";
    const To = ToRaw?.trim() || "UNKNOWN";
    let DateFormatted = convertDate(DateStr || "");
    if (!DateFormatted.includes(".")) DateFormatted = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")}`;
    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0];
    const Month = dfParts[1].padStart(2,"0");

    let Rate = From==="ICN"?0:PERDIEM_RATE[From]||3;
    let riDate=null, roDate=null;

    if (To==="ICN" && From!=="ICN") roDate=parseHHMMOffset(STDZ, DateFormatted);
    if (From==="ICN") riDate=parseHHMMOffset(STAZ, DateFormatted);
    if (From!=="ICN" && To!=="ICN") {
      riDate=parseHHMMOffset(STAZ, DateFormatted);
      roDate=parseHHMMOffset(STDZ, DateFormatted);
    }

    // Quick Turn 처리
    let isQuickTurnReturn=false;
    if (To==="ICN" && QUICK_DESTS.includes(From) && i>0) {
      const prevRow = flightRows[i-1];
      if (prevRow[6]==="ICN" && prevRow[9]===From) {
        const prevRI=parseHHMMOffset(prevRow[11], convertDate(prevRow[0]));
        if (prevRI instanceof Date && !isNaN(prevRI)) {
          isQuickTurnReturn=true;
          riDate=prevRI;
          if (!DateStr || !DateStr.trim()) DateFormatted=convertDate(prevRow[0]);
        }
      }
    }

    const riValid = riDate instanceof Date && !isNaN(riDate)?riDate:null;
    const roValid = roDate instanceof Date && !isNaN(roDate)?roDate:null;
    let { StayHours, Total } = calculatePerDiem(riValid, roValid, Rate);
    if (From==="ICN") StayHours="0:00";
    if (isQuickTurnReturn){ Total=33; Rate=33; }

    let TransportFee = 7000;
    if (isQuickTurnReturn) TransportFee=14000;

    // Firestore 중복 체크: Year+Month+Date+To
    const docId=`${Year}${Month}${DateFormatted.replace(/\./g,"")}_${To}`;

    perdiemList.push({
      Date: DateFormatted,
      Activity,
      From,
      To,
      Destination: To,
      RI: riValid?riValid.toISOString():"",
      RO: roValid?roValid.toISOString():"",
      StayHours,
      Rate,
      Total,
      TransportFee,
      Month,
      Year,
      docId
    });
  }

  return perdiemList;
}

// CSV 저장
export function savePerDiemCSV(perdiemList, outputPath="public/perdiem.csv"){
  if (!Array.isArray(perdiemList)) return;
  const header="Date,Activity,From,To,Destination,RI,RO,StayHours,Rate,Total,TransportFee,Month,Year\n";
  const rows=perdiemList.map(e=>`${e.Date},${e.Activity},${e.From},${e.To},${e.Destination},${e.RI},${e.RO},${e.StayHours},${e.Rate},${e.Total},${e.TransportFee},${e.Month},${e.Year}`);
  try {
    const fullPath=path.join(process.cwd(), outputPath);
    fs.mkdirSync(path.dirname(fullPath),{recursive:true});
    fs.writeFileSync(fullPath,header+rows.join("\n"),"utf-8");
    console.log(`✅ CSV 저장 완료: ${fullPath}`);
  }catch(err){console.error("❌ CSV 저장 실패:",err);}
}

// Firestore 업로드
export async function uploadPerDiemFirestore(perdiemList){
  const owner=process.env.FIRESTORE_ADMIN_UID||process.env.firestoreAdminUid||"";
  if (!Array.isArray(perdiemList)||!owner) return;
  if (!admin.apps.length) admin.initializeApp({credential:admin.credential.applicationDefault()});
  const db=admin.firestore();
  const collectionRef=db.collection("Perdiem");
  for (let item of perdiemList){
    await collectionRef.doc(item.docId).set({owner,...item});
  }
  console.log(`✅ Firestore 업로드 완료 (${perdiemList.length}건)`);
}