import fs from "fs";
import path from "path";
import csv from "csv-parser";
import admin from "firebase-admin";
import dayjs from "dayjs";

// 1️⃣ Firebase 서비스 계정 불러오기
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

// 🔸 GitHub Secrets 환경변수 사용
const FIREBASE_UID = process.env.FIREBASE_UID || "manual_upload";
const FIREBASE_EMAIL = process.env.FIREBASE_EMAIL || "unknown@manual";

// 2️⃣ CSV 자동 탐색
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

// 3️⃣ CSV 읽기 및 Firestore 업로드
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

    for (const [i, row] of rows.entries()) {
      try {
        // ✅ CSV Date → Firestore Timestamp(Date 타입)
        const csvDateStr = (row.Date || "").trim();
        let flightDate;
        const parsed = dayjs(csvDateStr, "DDMMMYY", "en");
        if (parsed.isValid()) {
          flightDate = parsed.toDate();
        } else {
          flightDate = new Date(); // fallback
        }

        // ✅ Firestore 저장 데이터 매핑
        const docData = {
          Date: flightDate,
          FLT: row.Activity || row.FLT || row["Flight No."] || "",
          FROM: row.From || row.FROM || "",
          TO: row.To || row.TO || "",
          REG: row["A/C ID"] || row.REG || "",
          DC: row["A/C Type"] || row.DC || "",
          BLK: row.BH || row.BLK || "00:00",
          PIC: row.PIC || "",
          Month: dayjs(flightDate).format("MMM"),
          Year: dayjs(flightDate).format("YYYY"),
          ET: row.ET || "00:00",
          NT: row.NT || "00:00",

          // 🔸 시간 필드는 string 그대로 저장
          STDz: (row.StartZ || row["STD(Z)"] || row.STDz || "").toString().trim(),
          STAz: (row.FinishZ || row["STA(Z)"] || row.STAz || "").toString().trim(),
          StartL: (row.StartL || "").toString().trim(),
          FinishL: (row.FinishL || "").toString().trim(),

          // 🔸 Block / Deadhead
          BH: (row.BH || "").trim(),
          DH: (row.DH || "00:00").trim(),

          // 🔸 사용자 정보
          owner: FIREBASE_UID,
          email: FIREBASE_EMAIL, // ✅ GitHub Secrets의 FIREBASE_EMAIL 사용
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // ✅ 중복 제거 (Date + FLT + FROM + TO 기준)
        const dupQuery = await db
          .collection("Flightlog")
          .where("Date", "==", flightDate)
          .where("FLT", "==", docData.FLT)
          .where("FROM", "==", docData.FROM)
          .where("TO", "==", docData.TO)
          .get();

        if (!dupQuery.empty) {
          console.log(`⚠️ 중복 데이터 발견 → 기존 문서 삭제 (${docData.FLT} ${csvDateStr})`);
          for (const d of dupQuery.docs) {
            await db.collection("Flightlog").doc(d.id).delete();
          }
        }

        await db.collection("Flightlog").add(docData);
        console.log(`✅ ${i + 1}/${rows.length} 저장 완료 (${csvDateStr} ${docData.FLT})`);
      } catch (err) {
        console.error(`❌ ${i + 1}행 오류: ${err.message}`);
      }
    }

    console.log("🎯 Firestore Flightlog 업로드 완료!");
  });
