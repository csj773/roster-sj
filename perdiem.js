import fs from "fs";
import path from "path";
import admin from "firebase-admin";

// ------------------- 공항별 PER DIEM -------------------
const PERDIEM_RATE = {
  LAX: 3.42,
  EWR: 3.44,
  HNL: 3.01,
  FRA: 3.18,
  BCN: 3.11,
  BKK: 2.14,
  DAD: 2.01,
  SFO: 3.42,
  OSL: 3.24,
  DAC: 30,
  NRT: 30,
  HKG: 30
};

// ------------------- Date 변환 -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/); // ["Mon","01"]
  if (parts.length !== 2) return input;
  const dayStr = parts[1].padStart(2,"0");
  const now = new Date();
  const month = String(now.getMonth()+1).padStart(2,"0");
  const year = now.getFullYear();
  return `${year}.${month}.${dayStr}`;
}

// ------------------- HHMM±offset → Date 객체 변환 -------------------
function parseHHMMOffset(hhmmStr, baseDateStr) {
  // baseDateStr: YYYY.MM.DD
  const [year, month, day] = baseDateStr.split(".").map(Number);
  const match = hhmmStr.match(/^(\d{2,4})(?:\+(\d+))?$/); // e.g., 1939+1
  if(!match) return null;

  let hhmm = match[1].padStart(4,"0");
  let hours = parseInt(hhmm.slice(0,2));
  let minutes = parseInt(hhmm.slice(2,4));
  let dayOffset = match[2] ? parseInt(match[2]) : 0;

  return new Date(year, month-1, day + dayOffset, hours, minutes);
}

// ------------------- 시간 → HH:MM 문자열 -------------------
function hourToTimeStr(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h)*60);
  return `${h}:${m.toString().padStart(2,"0")}`;
}

// ------------------- PerDiem 계산 -------------------
export function calculatePerDiem(riUTC, roUTC, destination) {
  const diffHours = (roUTC - riUTC)/1000/3600;
  const rate = PERDIEM_RATE[destination] || 3;
  return { 
    StayHours: hourToTimeStr(diffHours),
    Rate: rate,
    Total: Math.round(diffHours * rate * 100)/100
  };
}

// ------------------- Roster.json → PerDiem 리스트 -------------------
export function generatePerDiemList(rosterJsonPath) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath,"utf-8"));
  const rows = raw.values.slice(1);
  const perdiemList = [];

  const now = new Date();
  const Year = String(now.getFullYear());
  const Month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getMonth()];

  for(let i=0;i<rows.length;i++){
    const row = rows[i];
    const [DateStr,, , , Activity, , From, , STDZ, To, , STAZ] = row;
    if(!Activity || !From || !To || From === To) continue;

    const DateFormatted = convertDate(DateStr);

    // 기본 StayHours/Rate/Total
    let riUTC = parseHHMMOffset(STAZ, DateFormatted);
    let roUTC = parseHHMMOffset(STAZ, DateFormatted);
    let StayHours = "0:00";
    let Rate = PERDIEM_RATE[To] || 3;
    let Total = 0;

    // 해외공항 출발 → ICN 도착 구간 Stay 계산
    if(To === "ICN" && i>0){
      const prevRow = rows[i-1];
      const prevFrom = prevRow[6];
      const prevTo = prevRow[9];
      const prevSTAZ = prevRow[11];
      const prevDate = convertDate(prevRow[0]);
      if(prevTo !== "ICN"){ 
        const ri = parseHHMMOffset(prevSTAZ, prevDate);
        const ro = parseHHMMOffset(STAZ, DateFormatted);
        const perd = calculatePerDiem(ri, ro, prevTo);
        // 이전 해외공항 출발편에 저장
        const existing = perdiemList.find(p => p.Destination === prevTo && p.Date === prevDate);
        if(existing){
          existing.StayHours = perd.StayHours;
          existing.Total = perd.Total;
          existing.Rate = perd.Rate;
        }
      }
      // ICN 도착편
      StayHours = "0:00";
      Total = 0;
    }

    // 해외공항 도착/ICN 출발 구간 이외
    if(To !== "ICN") StayHours = "0:00"; // 다른 도착편 StayHours = 0

    perdiemList.push({
      Date: DateFormatted,
      Destination: To,
      Month,
      RI: STAZ,
      RO: STAZ,
      Rate,
      StayHours,
      Total,
      Year
    });
  }
  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath="public/perdiem.csv"){
  const headers = ["Date","Destination","Month","RI","RO","Rate","StayHours","Total","Year"];
  const csvRows = [headers.join(",")];
  for(const row of perdiemList){
    csvRows.push(headers.map(h => `"${row[h]||""}"`).join(","));
  }
  const fullPath = path.join(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(fullPath), {recursive:true});
  fs.writeFileSync(fullPath, csvRows.join("\n"),"utf-8");
  console.log(`✅ CSV 저장 완료: ${fullPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, pdc_user_name){
  if(!admin.apps.length) admin.initializeApp({credential: admin.credential.applicationDefault()});
  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  for(const row of perdiemList){
    // 기존 중복 삭제
    const snapshot = await collection.where("Destination","==",row.Destination)
                                     .where("Date","==",row.Date)
                                     .get();
    if(!snapshot.empty){
      for(const doc of snapshot.docs) await collection.doc(doc.id).delete();
    }
    // Firestore 저장
    await collection.add({
      Date: row.Date,
      Destination: row.Destination,
      Month: row.Month,
      RI: row.RI,
      RO: row.RO,
      Rate: row.Rate,
      StayHours: row.StayHours,
      Total: row.Total,
      Year: row.Year,
      pdc_user_name
    });
  }
  console.log("✅ Firestore 업로드 완료");
}
