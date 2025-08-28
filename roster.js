import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { GoogleSpreadsheet } from "google-spreadsheet";

// JSON → CSV 변환 함수
function jsonToCsv(items, headers) {
  const csvRows = [];
  csvRows.push(headers.join(","));
  for (const row of items) {
    const values = headers.map(h => `"${String(row[h] ?? "").replace(/"/g, '""')}"`);
    csvRows.push(values.join(","));
  }
  return csvRows.join("\n");
}

(async () => {
  const browser = await puppeteer.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();

  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });
  console.log("👉 로그인 후 Roster 메뉴 클릭하세요.");
  await new Promise(r => setTimeout(r, 30000));

  const rosterLink = await page.evaluateHandle(() => {
    const links = Array.from(document.querySelectorAll("a"));
    return links.find(a => a.textContent.includes("Roster")) || null;
  });

  if (rosterLink) {
    await Promise.all([
      rosterLink.click(),
      page.waitForNavigation({ waitUntil: "networkidle0" }),
    ]);
    console.log("✅ Roster 메뉴 클릭 완료");
  } else {
    console.log("❌ Roster 링크를 찾지 못했습니다.");
    await browser.close();
    return;
  }

  await page.waitForSelector("table tr");

  const rosterRaw = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("table tr")).map(tr =>
      Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim())
    );
  });

  const headers = [
    "Date", "DC", "C", "C/I(L)", "C/O(L)", "Activity", "FLT", "G", "From",
    "STD(L)", "STD(Z)", "K", "To", "STA(L)", "STA(Z)", "O", "BLH", "Q",
    "AcReg", "S", "T", "ID", "Crew",
  ];

  const rows = rosterRaw.slice(1);
  const rosterData = rows.map(row =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] || ""]))
  );

  // --- public 폴더 생성 ---
  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  // --- JSON 저장 ---
  fs.writeFileSync(path.join(publicDir, "roster.json"), JSON.stringify({ items: rosterData }, null, 2), "utf-8");
  console.log("✅ roster.json 저장 완료");

  // --- CSV 저장 ---
  fs.writeFileSync(path.join(publicDir, "roster.csv"), jsonToCsv(rosterData, headers), "utf-8");
  console.log("✅ roster.csv 저장 완료");

  // --- Google Spreadsheet 저장 ---
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  await sheet.addRows(rosterData);
  console.log("✅ Google Sheets 저장 완료");

  await browser.close();
})();
