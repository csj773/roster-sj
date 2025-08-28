import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

(async () => {
  const browser = await puppeteer.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();

  // 로그인 페이지 접속
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", {
    waitUntil: "networkidle0",
  });

  console.log("👉 브라우저가 열렸습니다. 아이디/비밀번호 입력 후 Roster 메뉴를 클릭하세요.");
  await new Promise(resolve => setTimeout(resolve, 30000)); // 로그인 대기

  // ------------------- Roster 메뉴 클릭 -------------------
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

  // ------------------- Roster 테이블 추출 -------------------
  await page.waitForSelector("table tr");

  const rosterRaw = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("table tr")).map(tr =>
      Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim())
    );
  });

// 헤더 정의 (요청 순서)
  const headers = [
    "Date",      // row[0]
    "DC",        // row[1]
    "C/I(L)",    // row[2]
    "C/O(L)",    // row[3]
    "Activity",  // row[4]
    "F",         // row[5]
    "From",      // row[6]
    "STD(L)",    // row[7]
    "STD(Z)",    // row[8]
    "To",        // row[9]
    "STA(L)",    // row[10]
    "STA(Z)",    // row[11]
    "BLH",       // row[12]
    "AcReg",     // row[13]
    "Crew"       // row[14] <- 웹 테이블에서는 row[22]
  ];

  // JSON 변환 (헤더 순서대로, 누락된 값은 "")
  const values = [headers, ...rosterRaw.slice(1).map(row => [
    row[0]  || "",   // Date
    row[1]  || "",   // DC
    row[3]  || "",   // C/I(L)
    row[4]  || "",   // C/O(L)
    row[5]  || "",   // Activity
    row[6]  || "",   // F
    row[7]  || "",   // From
    row[8]  || "",   // STD(L)
    row[9]  || "",   // STD(Z)
    row[10] || "",   // To
    row[11] || "",   // STA(L)
    row[12] || "",   // STA(Z)
    row[13] || "",   // BLH
    row[14] || "",   // AcReg
    row[22] || ""    // Crew
  ])];

  // ------------------- 저장 경로 -------------------
  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  // JSON 저장
  const jsonFilePath = path.join(publicDir, "roster.json");
  fs.writeFileSync(jsonFilePath, JSON.stringify({ values }, null, 2), "utf-8");
  console.log("✅ roster.json 저장 완료:", jsonFilePath);

  // CSV 저장 (헤더 순서 그대로)
  const csvFilePath = path.join(publicDir, "roster.csv");
  const csvContent = values
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  fs.writeFileSync(csvFilePath, csvContent, "utf-8");
  console.log("✅ roster.csv 저장 완료:", csvFilePath);

  await browser.close();
})();