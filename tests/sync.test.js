import assert from "node:assert/strict";
import test from "node:test";

import { contentFingerprint } from "../src/fingerprint.js";
import { buildWorld } from "./helpers/world.js";

test("重复回执：同回执号同内容按指纹归并，只投递一次", () => {
  const g = buildWorld();
  const delivered = [];
  const deliver = (at) => {
    const e = g.store.append({
      eventType: "INSPECTION_RECORDED",
      aggregateType: "case",
      aggregateId: "c-offline",
      payload: { via: "offline-upload", at },
    });
    delivered.push(e.event_id);
    return e;
  };
  const payload = { finding: "温度超标", temp: 12 };
  const first = g.sync.upload({ receiptId: "rc1", capturedAt: "2026-09-21T00:00:00Z", uploadedAt: "2026-09-25T03:00:00Z", payload, deliver });
  const retry = g.sync.upload({ receiptId: "rc1", capturedAt: "2026-09-21T00:00:00Z", uploadedAt: "2026-09-25T03:05:00Z", payload, deliver });

  assert.equal(first.outcome, "accepted");
  assert.equal(retry.outcome, "deduped");
  assert.equal(retry.originalDeliveredEventId, first.deliveredEventId);
  assert.equal(delivered.length, 1); // 投递副作用只发生一次
});

test("异内容：同回执号不同内容不归并，两份保留并进入调查", () => {
  const g = buildWorld();
  g.sync.upload({ receiptId: "rc2", capturedAt: "t1", uploadedAt: "u1", payload: { temp: 12 } });
  const conflict = g.sync.upload({ receiptId: "rc2", capturedAt: "t1", uploadedAt: "u2", payload: { temp: 4 } });
  assert.equal(conflict.outcome, "investigation");

  // 两份不同内容都留痕
  const events = g.rawEvents().filter((e) => e.aggregate_id === "rc2");
  assert.ok(events.some((e) => e.event_type === "UPLOAD_RECEIVED"));
  assert.ok(events.some((e) => e.event_type === "RECEIPT_CONTENT_DIVERGED"));
  assert.notEqual(contentFingerprint({ temp: 12 }), contentFingerprint({ temp: 4 }));
});

test("中断期间到期的升级在恢复后补齐，且只执行一次", () => {
  const g = buildWorld();
  g.sync.goOffline("2026-09-24T00:00:00Z");
  g.sync.scheduleDue({ taskKey: "c1-escalate", dueAt: "2026-09-24T12:00:00Z", kind: "escalation", aggregateType: "case", aggregateId: "c1", payload: { reason: "整改逾期" } });

  // 断网期间即便到点也无法触发（模拟无 tick）；恢复时补齐
  const recovered = g.sync.recover("2026-09-25T05:00:00Z");
  assert.equal(recovered.caughtUp.length, 1);
  assert.equal(recovered.caughtUp[0].caughtUpAfterOutage, true);
  assert.equal(recovered.caughtUp[0].kind, "escalation");

  // 升级事件已落到案件
  const esc = g.rawEvents().filter((e) => e.event_type === "ESCALATION_RECORDED" && e.aggregate_id === "c1");
  assert.equal(esc.length, 1);

  // 再跑/重放不重复执行
  const rerun = g.sync.runDue({ asOf: "2026-09-26T00:00:00Z" });
  assert.equal(rerun.length, 0);
});

test("中断期间到期的通知在恢复后补齐，重复恢复调用不重复通知", () => {
  const notifications = [];
  const g = buildWorld({ notify: (task) => notifications.push(task.taskKey) });
  g.sync.goOffline("2026-09-24T00:00:00Z");
  g.sync.scheduleDue({ taskKey: "c1-notify", dueAt: "2026-09-24T09:00:00Z", kind: "notification", aggregateType: "case", aggregateId: "c1" });
  g.sync.scheduleDue({ taskKey: "c2-notify-future", dueAt: "2026-09-30T09:00:00Z", kind: "notification", aggregateType: "case", aggregateId: "c2" });

  const recovered = g.sync.recover("2026-09-25T05:00:00Z");
  assert.equal(recovered.caughtUp.length, 1); // 未来到期的不提前执行
  assert.deepEqual(notifications, ["c1-notify"]);

  g.sync.recover("2026-09-25T06:00:00Z");
  assert.deepEqual(notifications, ["c1-notify"]); // 不重复通知
});

test("未到期任务在恢复时不执行，到期后正常触发", () => {
  const g = buildWorld();
  g.sync.scheduleDue({ taskKey: "future", dueAt: "2026-10-01T00:00:00Z", kind: "escalation", aggregateType: "case", aggregateId: "c9" });
  assert.equal(g.sync.runDue({ asOf: "2026-09-25T00:00:00Z" }).length, 0);
  assert.equal(g.sync.runDue({ asOf: "2026-10-02T00:00:00Z" }).length, 1);
});
