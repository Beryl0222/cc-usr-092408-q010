const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version"];

// 事件信封的最小校验：只校验结构性约定，业务规则由各领域服务负责。
// 事件一经接收不改写标识、发生时间与版本；业务更正应产生后继记录。
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length === 0)) {
    errors.push("event_id 必须是非空字符串");
  }
  if ("occurred_at" in record) {
    const time = Date.parse(record.occurred_at);
    if (Number.isNaN(time)) errors.push("occurred_at 必须是合法的 date-time");
  }
  if ("content_fingerprint" in record && !/^sha256:[0-9a-f]{64}$/.test(record.content_fingerprint)) {
    errors.push("content_fingerprint 必须形如 sha256:<64位十六进制>");
  }
  return errors;
}
