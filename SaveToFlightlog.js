/**
 * SaveToFlightlog.js (Secrets 기반)
 *
 * 🔹 GitHub Secrets 사용
 *    - FIREBASE_SERVICE_ACCOUNT_JSON
 *    - FIREBASE_UID
 * 🔹 PDC 로그인은 수동
 * 🔹 다운로드된 CSV Firestore 업로드
 */

import fs from "fs";
import csv from "csv-parser";
import admin from "firebase-admin";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);

// ------------------- Firebase 초기화 -------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT_JSON Secret이 없습니다.");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
if (serviceAccount.private_key)
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

if (!admin.apps.length)
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const FIREBASE_UID = process.env.FIREBASE_UID || "manual_upload";

// ------------------- BLH / ET / NT 계산 -------------------
function blhStrToHour(str){ /* 기존 함수 동일 */ }
function hourToTimeStr(hour){ /* 기존 함수 동일 */ }
function calculateET(blhStr){ /* 기존 함수 동일 */ }
function calculateNTFromSTDSTA(stdZ, staZ, flightDate, blhStr){ /* 기존 함수 동일 */ }
function parseTimeToUTC(dateString, timeString){ /* 기존 함수 동일 */ }

// ------------------- CSV → Firestore -------------------
async function uploadCSVToFirestore(csvFile) {
  const rows = [];
  fs.createReadStream(csvFile)
    .pipe(csv())
    .on("data", data => rows.push(data))
    .on("end", async () => {
      console.log(`📄 CSV ${rows.length}건 로드 완료`);
      for (const [i, row] of rows.entries()) {
        try {
          const stdUTC = parseTimeToUTC(row.Date, row["STD(Z)"] || row.STDz);
          const staUTC = parseTimeToUTC(row.Date, row["STA(Z)"] || row.STAz);
          const blk = row.BLH || row["BLK"] || "";

          const docData = {
            Date: stdUTC || new Date(),
            FLT: row.FLT || row["Flight No."] || "",
            FROM: row.FROM || row["From"] || "",
            TO: row.TO || row["To"] || "",
            REG: row.REG || row["A/C ID"] || "",
            DC: row.DC || row["A/C Type"] || "",
            RO: stdUTC || null,
            RI: staUTC || null,
            BLK: blk,
            PIC: row.PIC || "",
            Month: dayjs(stdUTC).format("MM"),
            Year: dayjs(stdUTC).format("YYYY"),
            ET: calculateET(blk),
            NT: calculateNTFromSTDSTA(row.STDz || row["STD(Z)"], row.STAz || row["STA(Z)"], row.Date || new Date(), blk),
            STDz: row.STDz || row["STD(Z)"] || "",
            STAz: row.STAz || row["STA(Z)"] || "",
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

// ------------------- 실행 안내 -------------------
console.log("🟢 PDC 로그인 후, 기간 선택과 CSV 다운로드를 수동으로 진행하세요.");
console.log("다운로드 완료 후, 터미널에서 Enter를 눌러 CSV Firestore 업로드를 시작합니다.");

process.stdin.once("data", async () => {
  const csvFile = process.argv[2];
  if (!csvFile) {
    console.error("❌ CSV 파일 경로를 지정해주세요. 예: node SaveToFlightlog.js ./my_flightlog.csv");
    process.exit(1);
  }

  await uploadCSVToFirestore(csvFile);
  process.exit(0);
});
