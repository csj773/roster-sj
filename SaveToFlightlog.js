import fs from "fs";
import path from "path";
import csv from "csv-parser";
import admin from "firebase-admin";
import dayjs from "dayjs";

// 1. Firebase 서비스 계정 확인
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

// 2. my_flightlog.csv 자동 탐색 (루트 및 1단계 하위 폴더)
function findCsvFile(filename = "my_flightlog.csv", dir = process.cwd()) {
  const files = fs.readdirSync(dir);
  if (files.includes(filename)) return path.join(dir, filename);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      const nestedFiles = fs.readdirSync(fullPath);
      if (nestedFiles.includes(filename)) return path.join(fullPath, filename);
    }
  }

  return null;
}

const csvFile = process.argv[2] || findCsvFile();
if (!csvFile) {
  console.error("❌ my_flightlog.csv 파일을 찾을 수 없습니다.");
  process.exit(1);
}

console.log(`📄 CSV 파일 발견: ${csvFile}`);

// 3. CSV 읽기
const rows = [];
fs.createReadStream(csvFile)
  .pipe(csv())
  .on("data", (data) => rows.push(data))
  .on("end", async () => {
    if (rows.length === 0) {
      console.error("❌ CSV에 데이터가 없습니다");
      process.exit(1);
    }
    console.log(`📄 CSV ${rows.length}건 로드 완료`);

    // 4. Firestore 업로드
    for (const [i, row] of rows.entries()) {
      try {
        const docData = {
          Date: row.Date || new Date(),
          FLT: row.FLT || row["Flight No."] || "",
          FROM: row.From || row.FROM || "",
          TO: row.To || row.TO || "",
          REG: row["A/C ID"] || row.REG || "",
          DC: row["A/C Type"] || row.DC || "",
          BLK: parseFloat(row.BLH || 0),
          PIC: row.PIC || "",
          Month: dayjs(row.Date).format("MM"),
          Year: dayjs(row.Date).format("YYYY"),
          ET: parseFloat(row.BLH || 0),
          NT: parseFloat(row.STDz || 0),
          STDz: row["STD(Z)"] || row.STDz || "",
          STAz: row["STA(Z)"] || row.STAz || "",
          DateString: row.Date || "",
          TKO: Number(row["T/O"] || row.TKO || 0),
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










