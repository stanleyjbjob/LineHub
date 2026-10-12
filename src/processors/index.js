import { keywordAlert } from './keyword-alert.js';
import { forwardWebhook } from './forward-webhook.js';
import { botCommand } from './bot-command.js';

// 新增後續應用：實作 { name, handle(ctx) } 並加入此陣列即可
// ctx = { event, message, store, line, config, log, bus }
export function defaultProcessors() {
  return [keywordAlert(), forwardWebhook(), botCommand()];
}
