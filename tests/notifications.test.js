import assert from "node:assert/strict";
import test from "node:test";

import { Action, ErrorCode, RiskLevel } from "../src/index.js";
import { buildScenario, roles } from "./helpers.js";

function rectifyCase(s, deadline = "2026-09-28T18:00:00+08:00") {
  const caseId = s.compliance.openCase({
    brandId: "brand_mx",
    storeId: "stall_1",
    source: "inspection",
    openedBy: roles.office,
  });
  const issueId = s.compliance.recordIssue({
    caseId,
    standardVersionId: "std_v1",
    evidence: [{ type: "photo", contentHash: "ev1" }],
    severity: "medium",
    foodSafetyCritical: false,
    scope: { stores: ["stall_1"], categories: ["cat_noodle"] },
    recordedBy: roles.inspector,
  });
  s.compliance.confirmRisk(caseId, issueId, { risk: RiskLevel.MEDIUM, inspector: roles.inspector });
  const { enforcementId } = s.compliance.decideEnforcement({
    caseId,
    action: Action.RECTIFY_WITH_DEADLINE,
    issueIds: [issueId],
    deadline,
    decidedBy: roles.inspector,
  });
  return { caseId, issueId, enforcementId };
}

test("中断期间到期的升级与通知在恢复后补齐，且重复恢复不重复执行", () => {
  const sink = [];
  const s = buildScenario({ notificationSink: (n) => sink.push(n.idempotencyKey) });
  const { enforcementId } = rectifyCase(s);

  // 中断前（09-25）：仅处置通知到期；逾期升级（09-28）未到期
  const before = s.notifications.dispatchDue({ now: "2026-09-25T09:00:00+08:00" });
  assert.deepEqual(before, [`action_notice:${enforcementId}`]);

  // 系统中断直到 09-29：推进时钟模拟恢复时刻，补齐所有到期通知
  s.clock.set("2026-09-29T08:00:00+08:00");
  const backfilled = s.notifications.recover();
  // 09-29 时到期的：到期提醒、逾期升级
  assert.deepEqual(backfilled.sort(), [
    `deadline_reminder:${enforcementId}`,
    `risk_escalation:${enforcementId}`,
  ]);
  for (const key of backfilled) {
    const n = s.notifications.view().notifications.get(key);
    assert.equal(n.backfill, true);
  }

  // 再恢复/再扫描：没有任何通知被重复发送
  assert.deepEqual(s.notifications.recover(), []);
  assert.deepEqual(s.notifications.dispatchDue({ now: "2026-10-01T00:00:00+08:00" }), []);

  // sink 实际只收到 3 条，且无重复
  assert.equal(sink.length, 3);
  assert.equal(new Set(sink).size, 3);
});

test("申诉期间挂起的通知在中断期间也不发送；申诉驳回后恢复排期并幂等补发", () => {
  const sink = [];
  const s = buildScenario({ notificationSink: (n) => sink.push(n.idempotencyKey) });
  const { caseId, enforcementId } = rectifyCase(s);

  s.compliance.fileAppeal({
    caseId,
    enforcementId,
    reason: "异议",
    filedBy: roles.operatorB,
  });

  // 申诉期间即便已过截止时间，挂起的提醒/升级也不发送
  assert.deepEqual(s.notifications.dispatchDue({ now: "2026-09-29T00:00:00+08:00" }), []);

  // 申诉驳回（upheld）：恢复排期，恢复后补发一次
  s.compliance.decideAppeal({
    caseId,
    enforcementId,
    decision: "upheld",
    decidedBy: roles.reviewer2,
  });
  const sent = s.notifications.dispatchDue({ now: "2026-09-29T12:00:00+08:00" });
  assert.ok(sent.includes(`risk_escalation:${enforcementId}`));
  // 不重复
  assert.deepEqual(s.notifications.dispatchDue({ now: "2026-09-30T00:00:00+08:00" }), []);
});

test("申诉成立时取消挂起通知，任何恢复扫描都不再发送", () => {
  const sink = [];
  const s = buildScenario({ notificationSink: (n) => sink.push(n.idempotencyKey) });
  const { caseId, enforcementId } = rectifyCase(s);
  s.compliance.fileAppeal({ caseId, enforcementId, reason: "异议", filedBy: roles.operatorB });
  s.compliance.decideAppeal({
    caseId,
    enforcementId,
    decision: "overturned",
    decidedBy: roles.reviewer2,
  });
  assert.deepEqual(s.notifications.recover(), []);
  assert.deepEqual(sink, []);
});

test("同一幂等键重复排期只产生一条通知", () => {
  const s = buildScenario();
  const key = "action_notice:fixed-key";
  s.notifications.schedule({
    key,
    kind: "action_notice",
    channel: "operator",
    target: { storeId: "stall_1" },
    scheduledFor: "2026-09-25T09:00:00+08:00",
    payload: {},
  });
  s.notifications.schedule({
    key,
    kind: "action_notice",
    channel: "operator",
    target: { storeId: "stall_1" },
    scheduledFor: "2026-09-25T09:00:00+08:00",
    payload: { again: true },
  });
  assert.equal(s.notifications.view().notifications.size, 1);
});
