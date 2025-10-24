import fs from "fs";
import path from "path";
import csv from "csv-parser";
import admin from "firebase-admin";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
dayjs.extend(customParseFormat);

// ------------------- ET/NT 계산 유틸 -------------------

function blhStrToHour(str) {
  if (!str) return 0;
  if (typeof str !== "string") str = String(str);
  str = str.trim();
  if (str.includes(":")) {
    const [h, m] = str.split(":").map(Number);
    return h + m / 60;
  }
  if (/^\d{3,4}$/.test(str)) {
    const h = Number(str.slice(0, -2));
    const m = Number(str.slice(-2));
    return h + m / 60;
  }
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
  return 0;
}

function hourToTimeStr(hour) {
  if (hour == null || Number.isNaN(hour)) return "00:00";
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h + 1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function calculateET(blhStr) {
  const blh = blhStrToHour(blhStr);
  return blh > 8 ? hourToTimeStr(blh - 8) : "00:00";
}

function parseTimeWithOffset(t) {
  if (!t) return null;
  t = t.trim();
  const m = t.match(/^(\d{1,2})(\d{2})([+-]\d)?$/);
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]), offsetDays: m[3] ? Number(m[3]) : 0 };
}

function calculateNTFromSTDSTA(stdZ, staZ, flightDate, blhStr) {
  if (!stdZ || !staZ) return "00:00";
  const pStd = parseTimeWithOffset(stdZ);
  const pSta = parseTimeWithOffset(staZ);
  if (!pStd || !pSta) return "00:00";

  const y = flightDate.getUTCFullYear();
  const m = flightDate.getUTCMonth();
  const d = flightDate.getUTCDate();

  const stdDate = new Date(Date.UTC(y, m, d, pStd.hh, pStd.mm, 0));
  stdDate.setUTCDate(stdDate.getUTCDate() + pStd.offsetDays);

  const staDate = new Date(Date.UTC(y, m, d, pSta.hh, pSta.mm, 0));
  staDate.setUTCDate(staDate.getUTCDate() + pSta.offsetDays);
  if (staDate < stdDate) staDate.setUTCDate(staDate.getUTCDate() + 1);

  const startDay = new Date(Date.UTC(stdDate.getUTCFullYear(), stdDate.getUTCMonth(), stdDate.getUTCDate()));
  const endDay = new Date(Date.UTC(staDate.getUTCFullYear(), staDate.getUTCMonth(), staDate.getUTCDate()));

  let cursor = new Date(startDay);
  let totalNT = 0;

  while (cursor <= endDay) {
    const ntStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 13, 0, 0));
    const ntEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 21, 0, 0));
    const overlapStart = new Date(Math.max(stdDate, ntStart));
    const overlapEnd = new Date(Math.min(staDate, ntEnd));
    if (overlapStart < overlapEnd) totalNT += (overlapEnd - overlapStart) / 3600000;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const blhHour = blhStrToHour(blhStr);
  const finalNT = Math.min(totalNT, blhHour || Infinity, 8);
  return hourToTimeStr(finalNT);
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
const FIREBASE_UID = process.env.FIREBASE_UID || "manual_upload";

// ------------------- CSV 탐색 -------------------

function findCsvFile(filename = "my_flightlog.csv", dir = process.cwd()) {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (f === filename) return full;
    if (fs.statSync(full).isDirectory()) {
      const nested = findCsvFile(filename, full);
      if (nested) return nested;
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

// ------------------- CSV 파싱 및 Firestore 업로드 -------------------

function parseFlightDate(csvDateStr) {
  if (!csvDateStr) return new Date();

  const normalized = csvDateStr
    .replace(/(\d+)\.(\w+)\.(\d{2,4})/, "$1 $2 $3")
    .replace(/\s+/g, " ")
    .trim();

  const parsed = dayjs(normalized, ["D MMM YY", "DD MMM YY", "D MMM YYYY"], "en", true);
  if (parsed.isValid()) return parsed.toDate();

  console.warn(`⚠️ 날짜 파싱 실패 → ${csvDateStr}, 현재시간으로 대체`);
  return new Date();
}

const rows = [];
fs.createReadStream(csvFile)
  .pipe(csv())
  .on("data", (d) => rows.push(d))
  .on("end", async () => {
    if (!rows.length) {
      console.error("❌ CSV에 데이터가 없습니다.");
      process.exit(1);
    }
    console.log(`📄 ${rows.length}개 행 로드 완료`);

    for (const [i, row] of rows.entries()) {
      try {
        const csvDateStr = (row.Date || "").trim();
        const flightDate = parseFlightDate(csvDateStr);
        const flightTimestamp = admin.firestore.Timestamp.fromDate(flightDate);

        const blk = (row.BH || row.BLK || "00:00").trim();
        const stdZ = (row.StartZ || row["STD(Z)"] || "").trim();
        const staZ = (row.FinishZ || row["STA(Z)"] || "").trim();

        const ET = calculateET(blk);
        const NT = calculateNTFromSTDSTA(stdZ, staZ, flightDate, blk);

        const docData = {
          Date: flightTimestamp, // ✅ Firestore Timestamp 저장
          FLT: row.Activity || row.FLT || "",
          FROM: row.From || "",
          TO: row.To || "",
          REG: row["A/C ID"] || "",
          DC: row["A/C Type"] || row.DC || "",
          BLK: blk,
          PIC: row.PIC || "",
          ET,
          NT,
          STDz: stdZ,
          STAz: staZ,
          StartL: row.StartL || "",
          FinishL: row.FinishL || "",
          DH: (row.DH || "00:00").trim(),
          owner: FIREBASE_UID,
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // 중복 제거 (같은 날짜·FLT·FROM·TO)
        const dupQuery = await db
          .collection("Flightlog")
          .where("Date", "==", flightTimestamp)
          .where("FLT", "==", docData.FLT)
          .where("FROM", "==", docData.FROM)
          .where("TO", "==", docData.TO)
          .get();

        if (!dupQuery.empty) {
          await Promise.all(dupQuery.docs.map((d) => db.collection("Flightlog").doc(d.id).delete()));
        }

        await db.collection("Flightlog").add(docData);
        console.log(
          `✅ ${i + 1}/${rows.length} 저장 완료 (${csvDateStr} → ${flightDate.toISOString().split("T")[0]}) [${docData.FLT}]`
        );
      } catch (err) {
        console.error(`❌ ${i + 1}행 오류: ${err.message}`);
      }
    }

    console.log("🎯 Firestore Flightlog 업로드 완료!");
  });