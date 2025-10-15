import fs from "fs";
import path from "path";
import csv from "csv-parser";
import admin from "firebase-admin";
import dayjs from "dayjs";

// Firebase 서비스 계정 확인
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
const FIREBASE_EMAIL = process.env.FIREBASE_EMAIL || "";

// CSV 자동 탐색
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

console.log("🚀 Flightlog Firestore 업로드 시작");
console.log(`📄 CSV 파일 발견: ${csvFile}`);

// CSV 읽기
const values = [];
fs.createReadStream(csvFile)
  .pipe(csv())
  .on("data", (data) => values.push(data))
  .on("end", async () => {
    if (!values.length) {
      console.error("❌ CSV에 데이터가 없습니다");
      process.exit(1);
    }

    const headers = Object.keys(values[0]);

    function buildDocData(row, i) {
      const docData = {};
      headers.forEach((h) => { docData[h] = row[h] || ""; });

      // Date → Firestore Timestamp
      const rawDate = docData.Date || new Date();
      docData.Date = admin.firestore.Timestamp.fromDate(new Date(rawDate));

      docData.userId = FIREBASE_UID;
      docData.Email = FIREBASE_EMAIL;

      if (!docData.Activity || !docData.Activity.trim()) return null;

      // hh:mm 타입 필드
      docData.ET = docData.BLH || "";
      docData.NT = (docData.STDZ && docData.STAZ && docData.From !== docData.To) ? docData.STDZ : "00:00";
      docData.PIC = docData.PIC || "";
      docData.P3 = docData.P3 || "";

      docData.Month = dayjs(rawDate).format("MMM");
      docData.Year = dayjs(rawDate).format("YYYY");

      Object.keys(docData).forEach(k => { if (docData[k] === undefined) delete docData[k]; });
      return docData;
    }

    async function uploadDoc(docData, i) {
      // 중복 제거: Date, DC, FLT, FROM, TO 기준
      const querySnapshot = await db.collection("Flightlog")
        .where("Date", "==", docData.Date)
        .where("DC", "==", docData.DC)
        .where("FLT", "==", docData.FLT)
        .where("FROM", "==", docData.FROM)
        .where("TO", "==", docData.TO)
        .get();

      if (!querySnapshot.empty) {
        for (const d of querySnapshot.docs) {
          await db.collection("Flightlog").doc(d.id).delete();
        }
      }

      const newDocRef = await db.collection("Flightlog").add(docData);
      console.log(`✅ ${i}행 업로드 완료: ${newDocRef.id}, NT=${docData.NT}, ET=${docData.ET}, Month=${docData.Month}, Year=${docData.Year}`);
    }

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const docData = buildDocData(row, i);
      if (!docData) continue;
      await uploadDoc(docData, i + 1);
    }

    console.log("✅ Flightlog Firestore 업로드 완료");
  });



























