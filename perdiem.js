// perdiem.js
import fs from "fs";
import path from "path";
import admin from "firebase-admin";

// ------------------- PerDiem 리스트 생성 -------------------
export function generatePerDiemList(rosterJsonPath) {
  if (!fs.existsSync(rosterJsonPath)) {
    console.error("❌ roster.json 파일 없음:", rosterJsonPath);
    return [];
  }

  const data = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const values = data.values || [];
  if (values.length < 2) return [];

  const headers = values[0];
  const rows = values.slice(1);

  const perdiemList = rows.map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] || "";
    });

    // 기본 PerDiem 계산 (예: StayHours 그대로 사용)
    obj.Rate = Number(obj.Rate) || 1;
    obj.StayHours = Number(obj.BLH || obj.StayHours) || 0; 
    obj.Total = obj.StayHours * obj.Rate;

    return obj;
  });

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputDir = "./public") {
  if (!perdiemList || !perdiemList.length) return;

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const headers = Object.keys(perdiemList[0]);
  const csv = [
    headers.join(","),
    ...perdiemList.map(row => headers.map(h => `"${(row[h]||"").toString().replace(/"/g,'""')}"`).join(","))
  ].join("\n");

  const filePath = path.join(outputDir, "perdiem.csv");
  fs.writeFileSync(filePath, csv, "utf-8");
  console.log(`✅ CSV 저장 완료: ${filePath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList, userId, collectionName = "perdiem") {
  if (!perdiemList || !perdiemList.length) return;
  if (!userId) {
    console.error("❌ userId 필요");
    return;
  }

  const db = admin.firestore();

  for (const item of perdiemList) {
    // UID 포함 및 undefined 제거
    const docData = { ...item, userId };
    Object.keys(docData).forEach(key => {
      if (docData[key] === undefined) delete docData[key];
    });

    try {
      await db.collection(collectionName).add(docData);
      console.log(`✅ PerDiem Firestore 업로드 완료: ${item.Destination || ""}`);
    } catch (err) {
      console.error("❌ Firestore 업로드 실패:", err);
    }
  }
}

