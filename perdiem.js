// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 PER DIEM -------------------
export const PERDIEM_RATE = {
  LAX: 3.42, EWR: 3.44, HNL: 3.01, FRA: 3.18, BCN: 3.11,
  BKK: 2.14, NRT: 3.07, SYD: 3.25, BNE: 3.25, FUK: 3.01,
  SGN: 2.18, HAN: 2.18, KIX: 3.03, NGO: 3.03, DPS: 2.36,
  TPE: 2.91, MNL: 2.41, HKG: 2.93, NRTT: 3.07, CEBC: 3.11,
};

// ------------------- QUICK TURN 목적지 -------------------
export const QUICK_DESTS = ["NRT", "KIX", "FUK", "NGO", "HKG", "BKK", "DAD", "DPS"];

// ------------------- PERDIEM 계산 -------------------
export function generatePerDiemList(flightRows) {
  const perdiemList = [];

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const { Date, Activity, From, To, BH } = row;

    // REST 제외, YP로 시작하지 않으면 패스
    if (!Activity?.startsWith("YP") || Activity === "REST") continue;
    if (!From || !To || From === To) continue;

    let StayHours = "0:00";
    let Total = 0;
    let isQuickTurnReturn = false;

    // Quick Turn 판별: 전편이 ICN 출발 & 이번편이 ICN 도착 & 동일 목적지
    if (To === "ICN" && QUICK_DESTS.includes(From) && i > 0) {
      const prevRow = flightRows[i - 1];
      if (prevRow.From === "ICN" && prevRow.To === From) {
        const prevDate = prevRow.Date;
        isQuickTurnReturn = true;
        console.log(`⚡ Quick Turn 귀국편 감지: ${prevDate} → ${Date} (${From})`);
      }
    }

    // ===== 교통비 =====
    let TransportFee = 7000;
    if (isQuickTurnReturn) TransportFee = 14000;

    // ===== 체류시간 & PERDIEM 계산 =====
    const rate = PERDIEM_RATE[To] || 0;
    if (To !== "ICN" && From !== "ICN") {
      StayHours = BH || "0:00";
      const [h, m] = StayHours.split(":").map(Number);
      Total = rate * (h + m / 60);
    }

    perdiemList.push({
      ...row,
      StayHours,
      Total: Number(Total.toFixed(2)),
      TransportFee,
      isQuickTurnReturn,
    });
  }

  return perdiemList;
}

// ------------------- Firestore 업로드 -------------------
export async function uploadPerDiemFirestore(perdiemList) {
  const owner = process.env.FIRESTORE_ADMIN_UID || process.env.firestoreAdminUid || "";

  if (!Array.isArray(perdiemList) || !owner) {
    console.warn("❌ uploadPerDiemFirestore: 잘못된 입력 또는 FIRESTORE_ADMIN_UID 누락");
    return;
  }

  if (!admin.apps.length)
    admin.initializeApp({ credential: admin.credential.applicationDefault() });

  const db = admin.firestore();
  const collection = db.collection("Perdiem");

  console.log(`🚀 Firestore 업로드 시작: ${perdiemList.length}건 (owner=${owner})`);

  let successCount = 0;
  let failCount = 0;

  for (const row of perdiemList) {
    try {
      if (!row || !row.Date || !row.To) continue;

      const activity = String(row.Activity || "").trim();
      const from = String(row.From || "").trim().toUpperCase();
      const to = String(row.To || "").trim().toUpperCase();

      // 필터: REST 제외 + YP로 시작 + From ≠ To
      if (activity === "REST" || !activity.startsWith("YP") || from === to) {
        console.log(`⏭️ 업로드 제외: ${activity} (${from} → ${to})`);
        continue;
      }

      const data = { ...row, owner };

      // ✈️ ICN 출발편은 강제 설정
      if (from === "ICN") {
        data.StayHours = "0:00";
        data.Total = 0;
        data.TransportFee = 7000;
        console.log(`✈️ ICN 출발편 처리: ${row.Date} (${activity})`);
      }

      // 중복 방지 삭제
      const snapshot = await collection
        .where("To", "==", to)
        .where("Date", "==", row.Date)
        .where("owner", "==", owner)
        .get();

      if (!snapshot.empty) {
        for (const doc of snapshot.docs) {
          await collection.doc(doc.id).delete();
          console.log(`🗑️ 기존 문서 삭제: ${to}, ${row.Date}`);
        }
      }

      await collection.add(data);
      console.log(`✅ 업로드 완료: ${from} → ${to}, ${row.Date}`);
      successCount++;
    } catch (err) {
      console.error(`❌ Firestore 업로드 실패 (${row.From} → ${row.To}, ${row.Date}):`, err);
      failCount++;
    }
  }

  console.log(`🎯 Firestore 업로드 결과: ${successCount}건 성공, ${failCount}건 실패`);
}
