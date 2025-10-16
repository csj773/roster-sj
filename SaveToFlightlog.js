import fs from "fs";
import path from "path";
import csv from "csv-parser";
import admin from "firebase-admin";
import dayjs from "dayjs";

// ------------------- ET/NT 계산 유틸 -------------------

// 문자열 → 시간 변환
function blhStrToHour(str) {
  if (!str) return 0;
  let h = 0, m = 0;
  if (str.includes(":")) {
    [h, m] = str.split(":").map(Number);
  } else if (/^\d{3,4}$/.test(str)) {
    if (str.length === 3) {
      h = Number(str[0]);
      m = Number(str.slice(1, 3));
    } else {
      h = Number(str.slice(0, 2));
      m = Number(str.slice(2, 4));
    }
  }
  return h + m / 60;
}

// 시간 → 문자열 변환
function hourToTimeStr(hour) {
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h + 1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ET 계산
function calculateET(blhStr) {
  const blh = blhStrToHour(blhStr);
  return blh > 8 ? hourToTimeStr(blh - 8) : "00:00";
}

// NT 계산
function calculateNTFromSTDSTA(stdZ, staZ, flightDate, blhStr) {
  if (!stdZ || !staZ) return "00:00";

  let stdDate = new Date(flightDate);
  let stdH = Number(stdZ.slice(0, 2));
  let stdM = Number(stdZ.slice(2, 4));
  stdDate.setUTCHours(stdH, stdM, 0, 0);
  if (stdZ.includes("+1")) stdDate.setUTCDate(stdDate.getUTCDate() + 1);
  if (stdZ.includes("-1")) stdDate.setUTCDate(stdDate.getUTCDate() - 1);

  let staDate = new Date(flightDate);
  let staH = Number(staZ.slice(0, 2));
  let staM = Number(staZ.slice(2, 4));
  staDate.setUTCHours(staH, staM, 0, 0);
  if (staZ.includes("+1")) staDate.setUTCDate(staDate.getUTCDate() + 1);
  if (staZ.includes("-1")) staDate.setUTCDate(staDate.getUTCDate() - 1);

  let totalNT = 0;
  let cursor = new Date(stdDate);

  while (cursor < staDate) {
    const ntStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 13, 0, 0));
    const ntEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 21, 0, 0));

    const overlapStart = new Date(Math.max(stdDate, ntStart));
    const overlapEnd = new Date(Math.min(staDate, ntEnd));

    if (overlapStart < overlapEnd) totalNT += (overlapEnd - overlapStart) / 1000 / 3600;

    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  const blhHour = blhStr ? blhStrToHour(blhStr) : null;
  if (blhHour !== null && totalNT > blhHour) totalNT = blhHour;

  return hourToTimeStr(totalNT);
}

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

// ------------------- 기본 설정 -------------------
const FIREBASE_UID = process.env.FIREBASE_UID || "manual_upload";
const FIXED_EMAIL = "sjchoi787@gmail.com";

// ------------------- CSV 탐색 -------------------
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

// ------------------- CSV 읽기 및 Firestore 업로드 -------------------
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
        const csvDateStr = (row.Date || "").trim();
        const parsed = dayjs(csvDateStr, "DDMMMYY", "en");
        const flightDate = parsed.isValid() ? parsed.toDate() : new Date();

        // 🔹 NT / ET 계산 적용
        const blk = (row.BH || row.BLK || "00:00").trim();
        const stdZ = (row.StartZ || row["STD(Z)"] || row.STDz || "").toString().trim();
        const staZ = (row.FinishZ || row["STA(Z)"] || row.STAz || "").toString().trim();

        const ET = calculateET(blk);
        const NT = calculateNTFromSTDSTA(stdZ, staZ, flightDate, blk);

        const docData = {
          Date: flightDate,
          FLT: row.Activity || row.FLT || row["Flight No."] || "",
          FROM: row.From || row.FROM || "",
          TO: row.To || row.TO || "",
          REG: row["A/C ID"] || row.REG || "",
          DC: row["A/C Type"] || row.DC || "",
          BLK: blk,
          PIC: row.PIC || "",
          Month: dayjs(flightDate).format("MMM"),
          Year: dayjs(flightDate).format("YYYY"),
          ET,
          NT,
          STDz: stdZ,
          STAz: staZ,
          StartL: (row.StartL || "").toString().trim(),
          FinishL: (row.FinishL || "").toString().trim(),
          BH: blk,
          DH: (row.DH || "00:00").trim(),
          owner: FIREBASE_UID,
          email: FIXED_EMAIL,
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // 🔸 중복 제거 (Date + FLT + FROM + TO)
        const dupQuery = await db
          .collection("Flightlog")
          .where("Date", "==", flightDate)
          .where("FLT", "==", docData.FLT)
          .where("FROM", "==", docData.FROM)
          .where("TO", "==", docData.TO)
          .get();

        if (!dupQuery.empty) {
          for (const d of dupQuery.docs) {
            await db.collection("Flightlog").doc(d.id).delete();
          }
        }

        await db.collection("Flightlog").add(docData);
        console.log(`✅ ${i + 1}/${rows.length} 저장 완료 (${csvDateStr} ${docData.FLT}) [ET=${ET}, NT=${NT}]`);
      } catch (err) {
        console.error(`❌ ${i + 1}행 오류: ${err.message}`);
      }
    }

    console.log("🎯 Firestore Flightlog 업로드 완료!");
  });
