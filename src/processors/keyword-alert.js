// 範例應用 1：關鍵字警示（例如：客訴、報價、緊急），命中時寫入 alerts 並廣播到後台
export function keywordAlert() {
  return {
    name: 'keyword-alert',
    async handle({ message, store, config, bus }) {
      if (message.type !== 'text' || !config.alertKeywords.length) return;
      const hits = config.alertKeywords.filter((k) => message.text.toLowerCase().includes(k.toLowerCase()));
      for (const keyword of hits) store.insertAlert(message.id, message.source_id, keyword);
      if (hits.length) {
        message.alerts = hits;
        bus?.emit('alert', { message, keywords: hits });
      }
    },
  };
}
