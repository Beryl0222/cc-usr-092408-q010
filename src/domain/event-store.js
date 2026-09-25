import { randomUUID } from "node:crypto";
import { ErrorCode, fail } from "./errors.js";

// 事件存储：只追加、不可变。事件一旦写入，其标识、发生时间与版本不得原地改写；
// 业务更正必须产生后继事件。版本按聚合从 1 递增，写入时做乐观并发检查。
export class EventStore {
  constructor() {
    /** @type {Array<Record<string, unknown>>} */
    this.events = [];
    this.versions = new Map(); // aggregate_id -> 最新版本
    this.ids = new Set(); // event_id 去重
    /** @type {Set<(event: object) => void>} */
    this.subscribers = new Set();
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  versionOf(aggregateId) {
    return this.versions.get(aggregateId) ?? 0;
  }

  append(input, expectedVersion) {
    const event = {
      event_id: input.event_id ?? randomUUID(),
      event_type: input.event_type,
      aggregate_type: input.aggregate_type,
      aggregate_id: input.aggregate_id,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      version: input.version ?? (this.versions.get(input.aggregate_id) ?? 0) + 1,
      summary: input.summary,
      payload: input.payload ?? {},
    };
    if (this.ids.has(event.event_id)) {
      fail(ErrorCode.ALREADY_EXISTS, `事件已存在：${event.event_id}`, { event_id: event.event_id });
    }
    const current = this.versions.get(event.aggregate_id) ?? 0;
    const wanted = expectedVersion ?? current;
    if (wanted !== current) {
      fail(ErrorCode.CONFLICT, `聚合 ${event.aggregate_id} 版本冲突：期望 ${wanted}，实际 ${current}`, {
        aggregate_id: event.aggregate_id,
        expected: wanted,
        actual: current,
      });
    }
    if (event.version !== current + 1) {
      fail(ErrorCode.CONFLICT, `事件版本必须连续：期望 ${current + 1}，收到 ${event.version}`);
    }
    this.ids.add(event.event_id);
    this.versions.set(event.aggregate_id, event.version);
    this.events.push(event);
    for (const fn of this.subscribers) fn(event);
    return event;
  }

  read(aggregateId) {
    return this.events.filter((e) => e.aggregate_id === aggregateId);
  }

  all() {
    return [...this.events];
  }
}
