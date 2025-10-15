// ==================== SaveToFlightlog.js ====================
// 🔹 로그인 및 기간선택은 직접 수행
// 🔹 다운로드된 CSV를 Firestore에 업로드

import fs from "fs";
import csv from "csv-parser";
import admin from "firebase-admin";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);

// ------------------- Firebase 초기화 -------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT Secret이 없습니다.");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (serviceAccount.private_key)
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

if (!admin.apps.length)
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const FIREBASE_UID = process.env.FIREBASE_UID || "manual_upload";

// ------------------- BLH / ET / NT 계산 함수 -------------------
function blhStrToHour(str) {
  const match = str?.match(/(\d{2})(\d{2})/);
  if (!match) return 0;
  const [, h, m] = match.map(Number);
  return h + m / 60;
}
function calculateET(blhStr) {
  const hours = blhStrToHour(blhStr);
  return hours.toFixed(2);
}
function calculateNTFromSTDSTA(stdZ, staZ, dateStr, blhStr) {
  const std = blhStrToHour(stdZ);
  const sta = blhStrToHour(staZ);
  if (isNaN(std) || isNaN(sta)) return 0;
  const diff = sta - std;
  return diff < 0 ? diff + 24 : diff;
}

// ------------------- CSV → Firestore 업로드 -------------------
async function uploadCSVToFirestore(csvFile) {
  const rows = [];
  fs.createReadStream(csvFile)
    .pipe(csv())
    .on("data", data => rows.push(data))
    .on("end", async () => {
      console.log(`📄 CSV ${rows.length}건 로드 완료`);
      for (const [i, row] of rows.entries()) {
        try {
          const docData = {
            Date: row.Date || new Date(),
            FLT: row.FLT || row["Flight No."] || "",
            FROM: row.FROM || row["From"] || "",
            TO: row.TO || row["To"] || "",
            REG: row.REG || row["A/C ID"] || "",
            DC: row.DC || row["A/C Type"] || "",
            BLK: row.BLH || row["BLK"] || "",
            PIC: row.PIC || "",
            Month: dayjs(row.Date).format("MM"),
            Year: dayjs(row.Date).format("YYYY"),
            ET: calculateET(row.BLH),
            NT: calculateNTFromSTDSTA(row["STD(Z)"], row["STA(Z)"], row.Date, row.BLH),
            STDz: row["STD(Z)"] || "",
            STAz: row["STA(Z)"] || "",
            DateString: row.Date || "",
            TKO: Number(row.TKO || row["T/O"] || 0),
            LDG: Number(row.LDG || 0),
            owner: FIREBASE_UID,
            uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
          };

          await db.collection("Flightlog").add(docData);
          console.log(`✅ ${i + 1}/${rows.length} 저장 완료 (${row.Date} ${row.FLT})`);
        } catch (err) {
          console.error(`❌ ${i + 1}행 오류:`, err.message);
        }
      }
      console.log("🎯 Firestore 업로드 완료!");
    });
}

// ------------------- 실행 -------------------
console.log("🟢 PDC 로그인 후, 기간 선택과 CSV 다운로드를 수동으로 진행하세요.");
console.log("다운로드 완료 후, CSV 파일 경로를 지정해 Firestore 업로드를 시작합니다.");

const csvFile = process.argv[2];
if (!csvFile) {
  console.error("❌ CSV 파일 경로를 지정해주세요. 예: node SaveToFlightlog.js ./my_flightlog.csv");
  process.exit(1);
}

uploadCSVToFirestore(csvFile);

