import { Aggregate } from "../domain/constants.js";
import { EventType } from "../domain/event-types.js";
import { ErrorCode } from "../domain/errors.js";
import { Projection } from "../domain/projection.js";

// 通知服务（事务性 outbox）。
// 规则：
//  - 每条通知以幂等键标识，任何情况下最多发送一次；
//  - 系统中断（离线）期间到期的升级/通知不丢失：恢复时统一“补齐扫描”；
//  - 申诉期间相关通知挂起；申诉驳回/调整后恢复排期；申诉成立则取消；
//  - 补齐时对已过发送时间的通知立即补发，但已派发的绝不重复执行。
export class NotificationService {
  constructor(store, clock, sink = null) {
    this.store = store;
    this.clock = clock;
    // sink：真正的发送器（短信/消息推送等）。测试中收集到数组。
    this.sink = sink;
    this.outboxId = "outbox:default";
  }

  view() {
    return Projection.fromEvents(this.store.all());
  }

  schedule({ key, kind, channel, target, scheduledFor, payload = {} }) {
    if (this.view().notifications.has(key)) return key; // 幂等：同键只建一次
    const expected = this.store.versionOf(this.outboxId);
    this.store.append(
      {
        event_type: EventType.NOTIFICATION_SCHEDULED,
        aggregate_type: Aggregate.CASE, // outbox 复用案件聚合流，版本独立于案件
        aggregate_id: this.outboxId,
        occurred_at: this.clock.now(),
        summary: `通知排期：${kind}（${key}）`,
        payload: {
          idempotencyKey: key,
          kind,
          channel,
          target,
          scheduledFor: scheduledFor ?? this.clock.now(),
          payload,
        },
      },
      expected
    );
    return key;
  }

  #expectedOutbox() {
    return this.store.versionOf(this.outboxId);
  }

  #appendOutbox(eventType, summary, payload) {
    let expected;
    for (let attempt = 0; attempt < 3; attempt++) {
      expected = this.store.versionOf(this.outboxId);
      try {
        this.store.append(
          {
            event_type: eventType,
            aggregate_type: Aggregate.CASE,
            aggregate_id: this.outboxId,
            occurred_at: this.clock.now(),
            summary,
            payload,
          },
          expected
        );
        return;
      } catch (err) {
        if (err.code !== ErrorCode.CONFLICT || attempt === 2) throw err;
      }
    }
  }

  // 申诉挂起：把某处罚关联的全部待发通知置为 held。
  holdByAppeal(enforcementId, { reason }) {
    const due = this.#findByEnforcement(enforcementId, ["scheduled"]);
    for (const n of due) {
      this.#appendOutbox(EventType.NOTIFICATION_HELD, `申诉挂起通知：${n.idempotencyKey}`, {
        idempotencyKey: n.idempotencyKey,
        reason,
        enforcementId,
      });
    }
  }

  resumeByAppeal(enforcementId, nowIso) {
    const held = this.#findByEnforcement(enforcementId, ["held"]);
    for (const n of held) {
      this.#appendOutbox(EventType.NOTIFICATION_RESCHEDULED, `申诉结束，恢复排期：${n.idempotencyKey}`, {
        idempotencyKey: n.idempotencyKey,
        enforcementId,
        scheduledFor: nowIso,
      });
    }
  }

  cancelByEnforcement(enforcementId) {
    const due = this.#findByEnforcement(enforcementId, ["scheduled", "held"]);
    for (const n of due) {
      this.#appendOutbox(EventType.NOTIFICATION_CANCELLED, `处罚撤销，取消通知：${n.idempotencyKey}`, {
        idempotencyKey: n.idempotencyKey,
        enforcementId,
      });
    }
  }

  // 案件闭环（全部问题复查通过）后，取消该案未决的到期提醒/逾期升级，避免对已整改案件误发。
  cancelPendingForCase(caseId) {
    const due = [...this.view().notifications.values()].filter(
      (n) =>
        ["scheduled", "held"].includes(n.status) &&
        (n.kind === "deadline_reminder" || n.kind === "risk_escalation") &&
        n.payload?.caseId === caseId
    );
    for (const n of due) {
      this.#appendOutbox(EventType.NOTIFICATION_CANCELLED, `案件已闭环，取消未决通知：${n.idempotencyKey}`, {
        idempotencyKey: n.idempotencyKey,
        caseId,
      });
    }
    return due.map((n) => n.idempotencyKey);
  }

  #findByEnforcement(enforcementId, statuses) {
    return [...this.view().notifications.values()].filter(
      (n) => statuses.includes(n.status) && (n.payload?.enforcementId === enforcementId ||
        n.idempotencyKey.includes(enforcementId))
    );
  }

  // 到期派发。now 之前应发送、且仍处于 scheduled 的通知全部发送；
  // backfill=true 表示这是中断恢复后的补齐派发。
  dispatchDue({ backfill = false, now = this.clock.now() } = {}) {
    const view = this.view();
    const dispatched = [];
    for (const n of [...view.notifications.values()].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))) {
      if (n.status !== "scheduled") continue;
      // deadline_reminder 的真实触发时间取 payload.fireAt
      const fireAt = n.payload?.fireAt ?? n.scheduledFor;
      if (fireAt.localeCompare(now) > 0) continue;
      // 幂等派发：仅当状态仍是 scheduled 才追加 DISPATCHED，版本冲突时跳过（他人已发）。
      const expected = this.store.versionOf(this.outboxId);
      try {
        this.store.append(
          {
            event_type: EventType.NOTIFICATION_DISPATCHED,
            aggregate_type: Aggregate.CASE,
            aggregate_id: this.outboxId,
            occurred_at: now,
            summary: `${backfill ? "中断恢复补齐" : "到期"}发送：${n.kind}（${n.idempotencyKey}）`,
            payload: {
              idempotencyKey: n.idempotencyKey,
              kind: n.kind,
              channel: n.channel,
              target: n.target,
              payload: n.payload,
              backfill,
              dueAt: fireAt,
            },
          },
          expected
        );
        this.sink?.(n);
        dispatched.push(n.idempotencyKey);
      } catch (err) {
        if (err.code !== ErrorCode.CONFLICT) throw err;
        // 并发下他人已推进 outbox 版本：重新读取后由外层再次调用即可，本通知不会重复发。
      }
    }
    return dispatched;
  }

  // 中断恢复：等价于一次 backfill 派发扫描。期间到期的全部补发，且每个幂等键最多一次。
  // nowIso 为恢复时刻；不传则使用时钟当前时刻。
  recover(nowIso = this.clock.now()) {
    return this.dispatchDue({ backfill: true, now: nowIso });
  }
}
