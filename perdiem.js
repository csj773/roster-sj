
const departureUTC = parseUTCClock(data.STDz, dateObject);
let arrivalUTC = parseUTCClock(data.STAz, dateObject);

// 도착 시각이 출발 시각보다 앞이면 다음 날 도착으로 보정
// 단, STAz에 +1 등 날짜 이동 정보가 이미 있어도
// 실제 시각을 비교한 뒤 필요한 경우에만 보정합니다.
if (
  departureUTC &&
  arrivalUTC &&
  arrivalUTC.getTime() < departureUTC.getTime()
) {
  arrivalUTC.setUTCDate(arrivalUTC.getUTCDate() + 1);
}
