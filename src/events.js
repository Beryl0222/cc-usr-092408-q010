import { contentFingerprint } from "./fingerprint.js";
import { fail } from "./errors.js";

// 不可变事件日志。
// 约定（见 README 领域边界）：事件一旦被接收，其标识、发生时间和版本不应被原地改写；
// 业务更正应产生后继记录。因此 store 只允许 append，不提供 update/delete。
//
// 并发控制采用「每聚合版本号 + 期望版本」的乐观锁：两个角色并发复核同一案件时，
// 后提交者会收到 VERSION_CONFLICT，由上层标记为冲突而非静默覆盖。

let seq = 0;

export function createEventStore(options = {}) {
  const events = [];
  const indexes = new Map(); // aggregate_id -> event[]
  const now = options.clock ?? (() => new Date());
  const idGen =
    options.idGenerator ??
    ((type, aggregateId) => `${type}-${aggregateId}-${(++seq).toString(36)}-${Date.now().toString(36)}`);

  function append({ eventType, aggregateType, aggregateId, payload = {}, expectedVersion, actor, occurredAt }) {
    const history = indexes.get(aggregateId) ?? [];
    const currentVersion = history.length;
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      fail("VERSION_CONFLICT", `聚合 ${aggregateId} 版本冲突：期望 ${expectedVersion}，实际 ${currentVersion}`, {
        detail: { expectedVersion, currentVersion, aggregateId },
      });
    }
    const event = {
      event_id: idGen(eventType, aggregateId),
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: (occurredAt ?? now()).toISOString(),
      version: currentVersion + 1,
      actor: actor ?? null,
      payload,
    };
    // 内容指纹同时覆盖信封关键字段与负载，重复回执据此归并。
    event.content_fingerprint = contentFingerprint({
      event_type: event.event_type,
      aggregate_id: event.aggregate_id,
      payload,
    });
    events.push(event);
    indexes.set(aggregateId, [...history, event]);
    return event;
  }

  return {
    append,
    history: (aggregateId) => (indexes.get(aggregateId) ? [...indexes.get(aggregateId)] : []),
    all: () => [...events],
    // 按投影需要拉取相关聚合的全部事件。
    related: (aggregateIds) =>
      aggregateIds
        .flatMap((id) => indexes.get(id) ?? [])
        .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id)),
  };
}
