// 範例應用 2：把標準化後的訊息轉送到外部系統（n8n、Zapier、CRM、自家 API、AI 分析服務…）
export function forwardWebhook({ fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'forward-webhook',
    async handle({ message, config, log }) {
      if (!config.forwardWebhookUrl) return;
      const res = await fetchImpl(config.forwardWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPublicMessage(message)),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) log.warn(`[forward-webhook] ${res.status} from ${config.forwardWebhookUrl}`);
    },
  };
}

export function toPublicMessage(m) {
  return {
    id: m.id,
    source: { type: m.source_type, id: m.source_id, name: m.source_name },
    sender: { id: m.user_id, name: m.display_name, pictureUrl: m.picture_url },
    type: m.type,
    text: m.text,
    mediaPath: m.media_path,
    quotedMessageId: m.quoted_message_id,
    alerts: m.alerts || [],
    timestamp: m.timestamp,
    time: new Date(m.timestamp).toISOString(),
    raw: m.payload,
  };
}
