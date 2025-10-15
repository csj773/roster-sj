import fs from "fs";
import csv from "csv-parser";
import admin from "firebase-admin";
import dayjs from "dayjs";

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

const csvFile = process.argv[2];
if (!csvFile || !fs.existsSync(csvFile)) {
  console.error(`❌ CSV 파일을 찾을 수 없습니다: ${csvFile}`);
  process.exit(1);
}

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
          ET: parseFloat(row.BLH) || 0,
          NT: parseFloat(row.STDz || 0),
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





