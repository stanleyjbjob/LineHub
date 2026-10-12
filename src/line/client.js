// LINE Messaging API 的最小封裝（只用到 PoC 需要的端點）
const API = 'https://api.line.me/v2/bot';
const DATA_API = 'https://api-data.line.me/v2/bot';

export class LineClient {
  constructor(accessToken, { fetchImpl = globalThis.fetch } = {}) {
    this.token = accessToken;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.token);
  }

  async #request(url, { method = 'GET', body, raw = false } = {}) {
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`LINE API ${method} ${url} -> ${res.status} ${text}`);
      err.status = res.status;
      throw err;
    }
    if (raw) return res;
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  getGroupSummary(groupId) {
    return this.#request(`${API}/group/${groupId}/summary`);
  }

  getGroupMemberCount(groupId) {
    return this.#request(`${API}/group/${groupId}/members/count`);
  }

  getGroupMemberProfile(groupId, userId) {
    return this.#request(`${API}/group/${groupId}/member/${userId}`);
  }

  getRoomMemberProfile(roomId, userId) {
    return this.#request(`${API}/room/${roomId}/member/${userId}`);
  }

  getProfile(userId) {
    return this.#request(`${API}/profile/${userId}`);
  }

  // 圖片 / 影片 / 音訊 / 檔案內容（LINE 伺服器只保留一段時間）
  getMessageContent(messageId) {
    return this.#request(`${DATA_API}/message/${messageId}/content`, { raw: true });
  }

  replyMessage(replyToken, messages) {
    return this.#request(`${API}/message/reply`, {
      method: 'POST',
      body: { replyToken, messages },
    });
  }

  pushMessage(to, messages) {
    return this.#request(`${API}/message/push`, { method: 'POST', body: { to, messages } });
  }
}
