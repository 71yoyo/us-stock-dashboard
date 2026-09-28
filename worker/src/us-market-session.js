// 미국 장 마감은 서머타임에 따라 UTC 시각이 바뀐다. 고정 UTC 날짜 대신 뉴욕 현지 시간을 쓴다.
const newYorkClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function localParts(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('미국 시장 확인 시각이 올바르지 않습니다.');
  const parts = Object.fromEntries(newYorkClock.formatToParts(date)
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const isoDate = `${parts.year}-${parts.month}-${parts.day}`;
  return { isoDate, minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: new Date(`${isoDate}T00:00:00Z`).getUTCDay() };
}

function previousWeekday(isoDate) {
  const day = new Date(`${isoDate}T00:00:00Z`);
  do { day.setUTCDate(day.getUTCDate() - 1); }
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}

/** 정규장 종료 30분 뒤부터만 해당 거래일 일봉을 확인한다. 휴장일은 공급자의 빈 응답을 그대로 재시도한다. */
export function completedUsSessionDate(now = new Date()) {
  const { isoDate, minutes, weekday } = localParts(now);
  if (weekday === 0 || weekday === 6) return previousWeekday(isoDate);
  if (minutes >= 16 * 60 + 30) return isoDate;
  // 장 마감 전 오후에는 전 거래일을 다시 성공 처리하지 않고 대기한다.
  return minutes < 12 * 60 ? previousWeekday(isoDate) : null;
}

/** 기존 장중 Cron을 장 마감 후 일봉 확인으로 전환할지 판단한다. */
export function isUsSessionCompleteToday(now = new Date()) {
  const { minutes, weekday } = localParts(now);
  return weekday >= 1 && weekday <= 5 && minutes >= 16 * 60 + 30;
}
