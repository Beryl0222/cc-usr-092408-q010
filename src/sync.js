import { contentFingerprint } from "./fingerprint.js";
import { fail } from "./errors.js";

// 离线同步，两类问题：
//
// 1) 重复回执：现场弱网时检查员可能重试上传。按「内容指纹」归并——
//    - 回执号相同且指纹相同：判定为重复提交，只保留首份，幂等返回原投递结果；
//    - 回执号相同但内容不同：不归并，两份都保留并进入「调查」（回执可能被冒用或串单）。
//
// 2) 中断期间到期：整改截止触发的升级、通知在断网期间无法执行，
//    恢复连接后补齐；每个到期任务以稳定 key 去重，任何情况下只执行一次。

const SYNC_STATE_ID = "sync-state";

export function createReceiptLog(store) {
  function foldReceipt(receiptId) {
    let receipt = null;
    for (const e of store.history(receiptId)) {
      if (e.event_type === "UPLOAD_RECEIVED") {
        receipt = {
          receiptId,
          status: "received",
          firstFingerprint: e.payload.contentFingerprint,
          firstUpload: e.payload,
          divergences: receipt?.divergences ?? [],
        };
      } else if (e.event_type === "RECEIPT_DELIVERED") {
        receipt.status = "delivered";
        receipt.deliveredEventId = e.payload.deliveredEventId;
      } else if (e.event_type === "RECEIPT_CONTENT_DIVERGED") {
        receipt.status = "investigation";
        receipt.divergences.push(e.payload);
      }
    }
    return receipt;
  }

  // deliver(occurredAt) 只在首份内容上执行一次，返回领域事件。
  function ingest({ receiptId, capturedAt, uploadedAt, collectedOffline = true, payload, channel = "stall_app", deliver }) {
    const fingerprint = contentFingerprint(payload);
    const existing = foldReceipt(receiptId);

    if (existing) {
      if (existing.firstFingerprint === fingerprint) {
        // 同回执 + 同内容：重复提交，幂等归并，不再投递。
        return {
          outcome: "deduped",
          receiptId,
          fingerprint,
          originalDeliveredEventId: existing.deliveredEventId ?? null,
        };
      }
      // 同回执 + 异内容：保留两份，挂起调查，不自动投递第二份。
      const event = store.append({
        eventType: "RECEIPT_CONTENT_DIVERGED",
        aggregateType: "upload_receipt",
        aggregateId: receiptId,
        payload: {
          receiptId,
          firstFingerprint: existing.firstFingerprint,
          conflictingFingerprint: fingerprint,
          conflictingPayload: payload,
          capturedAt,
          uploadedAt,
          channel,
          reason: "同一回执号对应不同内容，疑似串单或回执冒用",
        },
      });
      return { outcome: "investigation", receiptId, fingerprint, divergenceEventId: event.event_id };
    }

    store.append({
      eventType: "UPLOAD_RECEIVED",
      aggregateType: "upload_receipt",
      aggregateId: receiptId,
      payload: {
        receiptId,
        contentFingerprint: fingerprint,
        capturedAt,
        uploadedAt,
        collectedOffline,
        channel,
      },
    });

    let deliveredEventId = null;
    if (deliver) {
      const delivered = deliver(uploadedAt);
      deliveredEventId = delivered?.event_id ?? null;
      store.append({
        eventType: "RECEIPT_DELIVERED",
        aggregateType: "upload_receipt",
        aggregateId: receiptId,
        payload: { receiptId, deliveredEventId, deliveredAt: uploadedAt },
      });
    }
    return { outcome: "accepted", receiptId, fingerprint, deliveredEventId };
  }

  return { ingest, foldReceipt };
}

// 到期任务（升级/通知）调度与补齐。
export function createDueTaskRunner(store, options = {}) {
  const notify = options.notify ?? (() => {});
  const now = options.clock ?? (() => new Date());

  function foldTask(taskId) {
    let task = null;
    for (const e of store.history(taskId)) {
      if (e.event_type === "DUE_TASK_SCHEDULED") task = { ...e.payload, taskId, status: "scheduled" };
      else if (e.event_type === "DUE_TASK_FIRED") Object.assign(task, e.payload, { status: "fired" });
    }
    return task;
  }

  function schedule({ taskKey, dueAt, kind, aggregateType, aggregateId, payload = {} }) {
    const taskId = `task_${taskKey}`;
    if (store.history(taskId).length) return foldTask(taskId); // 同一 key 重复调度是幂等的
    if (!["escalation", "notification"].includes(kind)) fail("INVALID_TASK_KIND", "到期任务类型须为 escalation/notification");
    store.append({
      eventType: "DUE_TASK_SCHEDULED",
      aggregateType: "due_task",
      aggregateId: taskId,
      payload: { taskKey, dueAt: iso(dueAt), kind, aggregateType, aggregateId, payload },
    });
    return foldTask(taskId);
  }

  // 立即/补齐执行所有「已到期且未执行」的任务。fired 状态构成幂等闸门，
  // 无论在线 tick 还是恢复后 catchup 调用多少次，每个任务只执行一次。
  function runDue({ asOf, outageStart = null } = {}) {
    const asOfIso = iso(asOf ?? now());
    const fired = [];
    const due = store
      .all()
      .filter((e) => e.event_type === "DUE_TASK_SCHEDULED")
      .map((e) => foldTask(e.aggregate_id))
      .filter((t) => t && t.status !== "fired" && t.dueAt <= asOfIso);

    for (const task of due) {
      const firedAt = asOfIso;
      const result = { taskKey: task.taskKey, kind: task.kind, firedAt, dueAt: task.dueAt, caughtUpAfterOutage: !!outageStart };

      if (task.kind === "escalation") {
        const event = store.append({
          eventType: "ESCALATION_RECORDED",
          aggregateType: task.aggregateType,
          aggregateId: task.aggregateId,
          payload: {
            taskKey: task.taskKey,
            reason: task.payload.reason ?? "整改期限届满未通过复核",
            dueAt: task.dueAt,
            firedAt,
            caughtUpAfterOutage: !!outageStart,
            level: task.payload.level ?? "escalated",
          },
        });
        result.eventId = event.event_id;
      } else {
        // 通知是外部副作用：先持久化意图再发送，重放时因 fired 闸门不会重复发送。
        try {
          notify({ ...task, firedAt });
          result.delivered = true;
        } catch (err) {
          result.delivered = false;
          result.error = String(err?.message ?? err);
        }
      }

      store.append({
        eventType: "DUE_TASK_FIRED",
        aggregateType: "due_task",
        aggregateId: task.taskId,
        payload: { firedAt, result },
      });
      fired.push(result);
    }
    return fired;
  }

  // 记录中断窗口；恢复时补齐窗口内（及更早遗留）到期任务。
  function goOffline(at) {
    return store.append({
      eventType: "OUTAGE_STARTED",
      aggregateType: "sync_state",
      aggregateId: SYNC_STATE_ID,
      payload: { startedAt: iso(at ?? now()) },
    });
  }

  function recover(at) {
    const recoveredAt = iso(at ?? now());
    const history = store.history(SYNC_STATE_ID);
    const lastStart = [...history].reverse().find((e) => e.event_type === "OUTAGE_STARTED")?.payload.startedAt ?? null;
    store.append({
      eventType: "OUTAGE_ENDED",
      aggregateType: "sync_state",
      aggregateId: SYNC_STATE_ID,
      payload: { startedAt: lastStart, recoveredAt },
    });
    const fired = runDue({ asOf: recoveredAt, outageStart: lastStart });
    return { recoveredAt, outageStart: lastStart, caughtUp: fired };
  }

  return { schedule, runDue, goOffline, recover, foldTask };
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}
