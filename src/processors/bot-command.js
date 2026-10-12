// 範例應用 3：群組內指令（展示 reply API）。預設關閉，讓 Bot 在群組中保持「只收不說」
export function botCommand() {
  return {
    name: 'bot-command',
    async handle({ event, message, store, line, config }) {
      if (!config.enableBotCommands || !line.enabled || message.type !== 'text') return;
      if (message.text.trim() !== '/hub') return;
      const count = store.listMessages({ sourceId: message.source_id, limit: 500 }).length;
      await line.replyMessage(event.replyToken, [{
        type: 'text',
        text: `LineHub 已記錄此聊天室 ${count >= 500 ? '500+' : count} 則訊息。`,
      }]);
    },
  };
}
