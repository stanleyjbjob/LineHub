// 時區工具：每日摘要以「當地日期」切分（預設 Asia/Taipei）

/** 回傳時間戳在指定時區的 YYYY-MM-DD */
export function localDate(ts, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ts));
}

/** 回傳時間戳在指定時區的 HH:mm */
export function localTime(ts, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ts));
}

function offsetOf(date, tz) {
  // 取當天中午的 UTC 偏移，例如 "GMT+08:00"
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value;
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] || '00'}` : 'Z';
}

/** 指定時區某一天的 [start, end) 毫秒時間戳 */
export function dayRange(date, tz) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error(`日期格式錯誤：${date}`), { status: 400 });
  const start = Date.parse(`${date}T00:00:00${offsetOf(date, tz)}`);
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const end = Date.parse(`${next}T00:00:00${offsetOf(next, tz)}`);
  return { start, end };
}

/** 前一天的 YYYY-MM-DD */
export function previousDate(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
