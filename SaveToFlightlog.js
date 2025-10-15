// SaveToFlightlog.js
import { getFirestore, collection, setDoc, doc } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import * as dayjs from "dayjs";

export const uploadFlightlogToFirestore = async (csvRows) => {
  const db = getFirestore();
  const auth = getAuth();
  const user = auth.currentUser;

  if (!user) {
    console.error("⚠️ 로그인된 사용자가 없습니다.");
    return;
  }

  const email = user.email || "";
  const uid = user.uid || "";

  for (const row of csvRows) {
    try {
      // Date 형식 변환
      const dateValue = row.Date
        ? new Date(row.Date)
        : new Date(); // CSV의 Date 값을 그대로 Firestore Timestamp로 저장

      const docData = {
        Date: dateValue, // Firestore Timestamp
        FLT: row.Activity || "", // Activity → FLT
        FROM: row.From || "", // From
        TO: row.To || "", // To
        REG: row.AcReg || "", // A/C Reg
        DC: row.DC || "", // DC
        BLK: row.BH || "", // BH
        PIC: row.PIC || "", // PIC (hh:mm type)
        P3: row.P3 || "", // optional
        ET: row.ET || "", // hh:mm type
        NT: row.NT || "", // hh:mm type
        STDz: row.StartZ || "", // StartZ
        STAz: row.FinishZ || "", // FinishZ
        Month: dayjs(row.Date).format("MMM"), // Oct, Nov, Dec...
        Year: dayjs(row.Date).format("YYYY"),
        Email: email, // FlutterFlow 로그인 유저 이메일
        UID: uid, // FlutterFlow 로그인 유저 UID
        createdAt: new Date(),
      };

      // 고유키(날짜+FLT+FROM+TO)로 중복 방지
      const uniqueId = `${dayjs(row.Date).format("YYYYMMDD")}_${row.Activity}_${row.From}_${row.To}`;
      const docRef = doc(collection(db, "Flightlog"), uniqueId);

      await setDoc(docRef, docData, { merge: true });
      console.log(`✅ Uploaded ${uniqueId}`);
    } catch (error) {
      console.error("❌ Upload failed:", error);
    }
  }

  console.log("✅ All CSV rows uploaded to Flightlog collection.");
};






























