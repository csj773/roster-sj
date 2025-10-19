// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 PER DIEM -------------------
export const PERDIEM_RATE = {
  LAX: 3.42, EWR: 3.44, HNL: 3.01, FRA: 3.18, BCN: 3.09,
  SFO: 3.42, CDG: 3.18, JFK: 3.44, SYD: 3.22, SEA: 3.42,
  ORD: 3.42, IAD: 3.44, YYZ: 3.25, MNL: 2.88, SGN: 2.88,
  FCO: 3.09, BKK: 2.88, DXB: 3.00, ICN: 0.00
};

// ------------------- PER DIEM 계산 함수 -------------------
export function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) {
    return { StayHours: "0:00", Total: 0 };
  }
  const diffMs = roDate - riDate;
  const diffHours = diffMs / (1000 * 60 * 60);
  const stayHours = hourToTimeStr(diffHours);
  const total = +(rate * diffHours).toFixed(2);
  return { StayHours: stayHours, Total: total };
}

// ------------------- PER DIEM 리스트 생성 -------------------
export function generatePerDiemList(rosterData) {
  const perdiemList = [];

  rosterData.forEach((flight) => {
    const {
      DateFormatted, Activity, From, To,
      riDate, roDate, isQuickTurnReturn,
      Month, Year
    } = flight;

    let Rate = PERDIEM_RATE[To] || 0;
    let { StayHours, Total } = calculatePerDiem(riDate, roDate, Rate);

    // ✅ From이 ICN인 경우도 무조건 포함
    if (From === "ICN") {
      StayHours = "0:00";
      Total = 0;
    }

    // Quick Turn 처리
    if (isQuickTurnReturn) {
      Total = 33;
      Rate = 33;
    }

    // ✅ push 항상 실행 (ICN 포함)
    perdiemList.push({
      Date: DateFormatted,
      Activity,
      From,
      Destination: To,
      RI: riDate ? riDate.toISOString() : "",
      RO: roDate ? roDate.toISOString() : "",
      StayHours,
      Rate,
      Total,
      Month,
      Year
    });
  });

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  const header = "Date,Activity,From,Destination,RI,RO,StayHours,Rate,Total,Month,Year\n";
  const csvContent = perdiemList.map((item) =>
    `${item.Date},${item.Activity},${item.From},${item.Destination},${item.RI},${item.RO},${item.StayHours},${item.Rate},${item.Total},${item.Month},${item.Year}`
  ).join("\n");

  fs.writeFileSync(outputPath, header + csvContent, "utf8");
  console.log(`✅ PerDiem CSV saved: ${outputPath}`);
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemToFirestore(perdiemList, uid) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
  }

  const db = admin.firestore();
  const userRef = db.collection("users").doc(uid);
  const perdiemRef = userRef.collection("perdiem");

  for (const item of perdiemList) {
    const docId = `${item.Year}-${item.Month}-${item.Date}-${item.Activity}`;
    await perdiemRef.doc(docId).set(item);
  }

  console.log("✅ PerDiem uploaded to Firestore");
}
