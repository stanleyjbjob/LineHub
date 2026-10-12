import { localDate, localTime, previousDate } from './time.js';

/**
 * 每分鐘檢查一次：當地時間到達 SUMMARY_TIME 後，為「前一天」產生摘要。
 * 已有摘要的群組會略過，所以服務重啟後重跑也不會重複呼叫模型。
 */
export function startScheduler({ summarizer, config, logger = console, now = Date.now }) {
  let lastRun = null;
  let running = false;
  const tick = async () => {
    const date = dueDate(now(), config.summaryTime, config.summaryTz, lastRun);
    if (!date || running) return;
    running = true;
    lastRun = localDate(now(), config.summaryTz);
    try {
      const results = await summarizer.runDaily(date);
      logger.log(`[summary] ${date} 每日摘要完成：${results.filter((r) => !r.error && !r.skipped).length} 個群組`);
    } catch (err) {
      logger.error('[summary] daily run failed', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  setImmediate(tick);
  return () => clearInterval(timer);
}

/** 若今天已過排程時間且今天還沒跑過，回傳要摘要的日期（前一天），否則 null */
export function dueDate(ts, time, tz, lastRun) {
  const today = localDate(ts, tz);
  if (lastRun === today || localTime(ts, tz) < time) return null;
  return previousDate(today);
}
