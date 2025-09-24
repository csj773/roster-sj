// ------------------- Google Sheets 초기화 (개선) -------------------
const rawSheetsCreds = getConfigValue("INPUT_GOOGLE_SHEETS_CREDENTIALS", "GOOGLE_SHEETS_CREDENTIALS");
if (!rawSheetsCreds) {
  console.error("❌ GOOGLE_SHEETS_CREDENTIALS 누락");
  process.exit(1);
}

let sheetsCredentials;
try {
  sheetsCredentials = JSON.parse(rawSheetsCreds); // JSON 파싱
  if (sheetsCredentials.private_key) {
    // 개행 문제 방지
    sheetsCredentials.private_key = sheetsCredentials.private_key.replace(/\\n/g, "\n");
  }
} catch (err) {
  console.error("❌ GOOGLE_SHEETS_CREDENTIALS JSON 파싱 실패:", err.message);
  process.exit(1);
}

// Google Sheets API 인증
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });

// ------------------- Google Sheets 업로드 함수 -------------------
async function updateGoogleSheet(spreadsheetId, sheetName, values, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        requestBody: { values },
      });
      console.log(`✅ Google Sheets A1부터 덮어쓰기 완료 (시도 ${attempt})`);
      break;
    } catch (err) {
      console.error(`❌ Google Sheets 업로드 실패 (시도 ${attempt}):`, err.message);
      if (attempt < maxRetries) {
        const delay = 1000 + Math.random() * 1000;
        console.log(`⏳ ${delay.toFixed(0)}ms 후 재시도...`);
        await new Promise((res) => setTimeout(res, delay));
      } else {
        console.error("❌ 최대 재시도 횟수 도달, 업로드 실패");
        process.exit(1);
      }
    }
  }
}

