import fs from "fs";
import path from "path";
import csv from "csv-parser";
import admin from "firebase-admin";
import dayjs from "dayjs";

// ------------------- ET/NT 계산 유틸 (패치됨) -------------------

// 문자열 → 시간 변환
function blhStrToHour(str) {
  if (!str) return 0;
  let h = 0, m = 0;
  if (typeof str !== "string") str = String(str);
  str = str.trim();
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
  } else if (/^\d+(\.\d+)?$/.test(str)) {
    // already decimal hours
    return Number(str);
  } else {
    return 0;
  }
  if (Number.isNaN(h)) h = 0;
  if (Number.isNaN(m)) m = 0;
  return h + m / 60;
}

// 시간 → 문자열 변환
function hourToTimeStr(hour) {
  if (hour == null || Number.isNaN(hour)) return "00:00";
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h + 1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ET 계산 (변경 없음)
function calculateET(blhStr) {
  const blh = blhStrToHour(blhStr);
  return blh > 8 ? hourToTimeStr(blh - 8) : "00:00";
}

/*
  NT 계산 (개선)
  - stdZ, staZ 형식 안정 파싱: ex "1744", "1744+1", "1744-1"
  - UTC 기준 Date 객체 구성
  - 각 날짜별로 Night window (13:00-21:00 UTC)와의 겹침만 합산
  - 총합을 블록시간(BLH)과 8시간 중 작은 값으로 cap
*/
function parseTimeWithOffset(t) {
  // returns { hh, mm, offsetDays }
  if (!t || typeof t !== "string") return null;
  const m = t.trim().match(/^(\d{2})(\d{2})([+-]\d)?$/);
  if (!m) {
    // try to extract digits and trailing +1/-1 anywhere
    const digits = (t.match(/(\d{3,4})/) || [null])[0];
    const ofs = (t.match(/([+-]\d+)/) || [null])[0];
    if (!digits) return null;
    const dd = digits.length === 3 ? [digits[0], digits.slice(1)] : [digits.slice(0,2), digits.slice(2)];
    const hh = Number(dd[0]), mm = Number(dd[1]);
    const offsetDays = ofs ? Number(ofs) : 0;
    return { hh, mm, offsetDays };
  }
  const hh = Number(m[1]), mm = Number(m[2]), offsetDays = m[3] ? Number(m[3]) : 0;
  return { hh, mm, offsetDays };
}

function calculateNTFromSTDSTA(stdZ, staZ, flightDate, blhStr) {
  // 안전성: 빈값 처리
  if (!stdZ || !staZ) return "00:00";
  const pStd = parseTimeWithOffset(stdZ);
  const pSta = parseTimeWithOffset(staZ);
  if (!pStd || !pSta) return "00:00";

  // Build UTC Date objects based on flightDate's Y-M-D (we treat flightDate as local date origin,
  // but we'll set UTC hours directly so we operate in UTC consistently)
  const y = flightDate.getUTCFullYear();
  const m = flightDate.getUTCMonth();
  const d = flightDate.getUTCDate();

  const stdDate = new Date(Date.UTC(y, m, d, pStd.hh, pStd.mm, 0));
  if (pStd.offsetDays) stdDate.setUTCDate(stdDate.getUTCDate() + pStd.offsetDays);

  const staDate = new Date(Date.UTC(y, m, d, pSta.hh, pSta.mm, 0));
  if (pSta.offsetDays) staDate.setUTCDate(staDate.getUTCDate() + pSta.offsetDays);

  // If staDate < stdDate (shouldn't happen normally), swap or adjust by adding a day to staDate
  if (staDate < stdDate) {
    // assume arrival is next day if earlier than departure time
    staDate.setUTCDate(staDate.getUTCDate() + 1);
  }

  // Night window per day: UTC 13:00 -> 21:00
  // Iterate days from floor(stdDate) to floor(staDate) inclusive
  const startDay = new Date(Date.UTC(stdDate.getUTCFullYear(), stdDate.getUTCMonth(), stdDate.getUTCDate(), 0,0,0));
  const endDay = new Date(Date.UTC(staDate.getUTCFullYear(), staDate.getUTCMonth(), staDate.getUTCDate(), 0,0,0));

  let cursor = new Date(startDay);
  let totalNT = 0;

  while (cursor <= endDay) {
    const ntWindowStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 13, 0, 0));
    const ntWindowEnd   = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 21, 0, 0));

    const overlapStart = new Date(Math.max(stdDate.getTime(), ntWindowStart.getTime()));
    const overlapEnd   = new Date(Math.min(staDate.getTime(), ntWindowEnd.getTime()));

    if (overlapStart < overlapEnd) {
      totalNT += (overlapEnd - overlapStart) / 1000 / 3600;
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // BLH cap and absolute 8-hour cap
  const blhHour = (blhStr != null && blhStr !== "") ? blhStrToHour(blhStr) : null;
  const capByBlh = (blhHour != null && !Number.isNaN(blhHour) && blhHour > 0) ? blhHour : Infinity;
  const absoluteCap = 8; // 8 hours maximum as requested
  const finalNT = Math.min(totalNT, capByBlh, absoluteCap);

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

        // 🔹 NT / ET 계산 적용 (패치된 함수 사용)
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