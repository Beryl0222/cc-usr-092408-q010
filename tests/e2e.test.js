import assert from "node:assert/strict";
import test from "node:test";

import { Action, ErrorCode, RiskLevel, EventType } from "../src/index.js";
import { buildScenario, roles, createApplication, MutableClock } from "./helpers.js";

// 端到端：复现题面叙事——
// 消费者投诉挂公用品牌招牌的档口 → 品牌办公室沿加盟关系追查 →
// 发现实际经营者已变更，品牌许可与适用品类仍停留在上一个主体 →
// 不直接吊销（避免连带同门店合规品类），而是穿透到实际档口、按品类局部停售 →
// 申诉冻结争议处罚但食品安全措施不解除 → 另一角色复核整改 → 复查通过仅恢复受影响范围；
// 期间离线重复回执按指纹归并、异内容留查；中断到期升级恢复后补齐不重复。
test("端到端：投诉穿透 → 主体变更 → 局部分品类处置 → 申诉 → 隔离复核 → 按范围恢复", () => {
  const sink = [];
  const s = buildScenario({ notificationSink: (n) => sink.push(n.idempotencyKey) });

  // 1) 消费者投诉立案
  const caseId = s.compliance.openCase({
    brandId: "brand_mx",
    storeId: "stall_1",
    source: "consumer_complaint",
    sourceRef: "12315-20260925-66",
    openedBy: roles.office,
    title: "消费者反映东街口档口拌面变质",
  });

  // 2) 品牌办公室沿加盟关系追查：招牌主体 op_a，现场实际经营者已是 op_c
  const trace = s.licensing.reportOperatorChange({
    storeId: "stall_1",
    previousOperatorId: "op_a",
    actualOperatorId: "op_c",
    actualOperatorName: "陈某",
    discoveredVia: "complaint_12315-20260925-66",
  });

  // 3) 旧许可关闭但历史责任留存；同门店 op_b 的合规品类许可不被连带吊销
  assert.deepEqual(trace.closedLicenses, ["lic_root"]);
  assert.equal(s.licensing.view().licenses.get("lic_root").closure.responsibilityRetained, true);
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").status, "active");

  // 4) 巡检问题绑定检查当时标准与证据，记录实际经营现场
  const issueNoodle = s.compliance.recordIssue({
    caseId,
    standardVersionId: "std_v1",
    evidence: [
      { type: "photo", contentHash: "sha256:ev_noodle_1", uri: "oss://ev/noodle1.jpg" },
      { type: "temperature_log", contentHash: "sha256:ev_temp_1" },
    ],
    severity: "high",
    foodSafetyCritical: true,
    scope: { stores: ["stall_1"], categories: ["cat_noodle"] },
    recordedBy: roles.inspector,
    operatorIdAtCheck: ["op_c"], // 现场实际经营者快照
  });
  // 扁肉品类没有问题，证明处置可以精确到品类
  const issueWonton = s.compliance.recordIssue({
    caseId,
    standardVersionId: "std_v1",
    evidence: [{ type: "photo", contentHash: "sha256:ev_wonton_ok" }],
    severity: "low",
    foodSafetyCritical: false,
    scope: { stores: ["stall_1"], categories: ["cat_wonton"] },
    recordedBy: roles.inspector,
    operatorIdAtCheck: ["op_c"],
  });

  // 5) 自动分级仅供参考，检查员确认；拌面高风险
  s.compliance.autoSuggest(caseId);
  const suggested = s.compliance.view().cases.get(caseId).issues.get(issueNoodle).suggestedRisk;
  assert.ok(suggested);
  s.compliance.confirmRisk(caseId, issueNoodle, { risk: RiskLevel.HIGH, inspector: roles.inspector });
  s.compliance.confirmRisk(caseId, issueWonton, { risk: RiskLevel.LOW, inspector: roles.inspector });

  // 6) 不吊销整店许可，仅对拌面局部停售 + 限期整改
  const enf = s.compliance.decideEnforcement({
    caseId,
    action: Action.PARTIAL_SUSPENSION,
    issueIds: [issueNoodle],
    decidedBy: roles.inspector,
    note: "拌面冷链失控；扁肉合规继续经营",
  });
  // 扁肉走限期整改而非停售
  const enfRectify = s.compliance.decideEnforcement({
    caseId,
    action: Action.RECTIFY_WITH_DEADLINE,
    issueIds: [issueWonton],
    deadline: "2026-09-30T18:00:00+08:00",
    decidedBy: roles.inspector,
  });

  // lic_sub_b 只被限制拌面；其覆盖范围正是拌面，故整条限制落在 cat_noodle
  const subBRestrictions = s.licensing.view().licenses.get("lic_sub_b").restrictions;
  assert.deepEqual(subBRestrictions.map((r) => r.scope.categories), [["cat_noodle"]]);

  // 7) 经营者申诉：只冻结争议处罚，停售这一食品安全措施不解除
  s.compliance.fileAppeal({
    caseId,
    enforcementId: enf.enforcementId,
    reason: "对温度日志取证程序有异议",
    filedBy: { id: "u_c", role: "operator" },
  });
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").restrictions.length, 1);
  // 申诉期间：该处罚关联通知挂起；食品安全措施（许可限制）不变
  assert.equal(s.notifications.view().notifications.get(`action_notice:${enf.enforcementId}`).status, "held");
  // 申诉被驳回：维持原处罚
  s.compliance.decideAppeal({
    caseId,
    enforcementId: enf.enforcementId,
    decision: "upheld",
    detail: "取证程序合法",
    decidedBy: roles.reviewer2,
  });

  // 8) 离线巡查员上传：同回执重复内容归并；异内容保留调查
  const offlineContent = {
    caseRef: "12315-20260925-66",
    storeId: "stall_1",
    checks: { cat_noodle: "cold_chain_fail", cat_wonton: "ok" },
  };
  const up1 = s.offline.upload({ receiptNo: "RC-7788", deviceId: "tablet-3", content: offlineContent });
  const up2 = s.offline.upload({
    receiptNo: "RC-7788",
    deviceId: "tablet-3",
    uploadedAt: "2026-09-25T19:00:00+08:00",
    content: { ...offlineContent }, // 同内容
  });
  assert.equal(up1.outcome, "registered");
  assert.equal(up2.outcome, "merged");
  assert.throws(
    () => s.offline.upload({ receiptNo: "RC-7788", deviceId: "tablet-9", content: { ...offlineContent, checks: { cat_noodle: "ok" } } }),
    (e) => e.code === ErrorCode.CONTENT_MISMATCH
  );

  // 9) 整改材料由另一角色复核（提交人是经营者，复核人是品牌质量复核员，且非原检查员）
  const submissionId = s.compliance.submitRemediation({
    caseId,
    issueIds: [issueNoodle, issueWonton],
    materials: [
      { type: "cold_chain_report", contentHash: "sha256:mat_cold" },
      { type: "training_record", contentHash: "sha256:mat_train" },
    ],
    submittedBy: { id: "u_c", role: "operator" },
  });
  s.compliance.reviewRemediation({
    caseId,
    submissionId,
    result: "approved",
    reviewer: roles.reviewer,
    note: "冷链整改到位、培训完成",
  });

  // 10) 复查：仅拌面通过 → 仅恢复拌面范围；扁肉尚未复查，其限制/整改继续
  s.compliance.recordReinspection({
    caseId,
    issueIds: [issueNoodle],
    passed: true,
    inspector: roles.inspector2,
    evidence: [{ type: "photo", contentHash: "sha256:reinspect_noodle_ok" }],
  });
  const rein = s.compliance.decideReinstatement({ caseId, decidedBy: roles.office });
  assert.deepEqual(rein.liftedScope.stores, ["stall_1"]);
  assert.ok(rein.liftedScope.categories.includes("cat_noodle"));
  assert.equal(rein.caseClosed, false);
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").restrictions.length, 0);

  // 11) 中断恢复：扁肉限期整改（截止 09-30）在中断期间到期，恢复后补齐升级且不重复
  s.clock.set("2026-10-02T08:00:00+08:00");
  const recovered = s.notifications.recover();
  assert.ok(recovered.includes(`risk_escalation:${enfRectify.enforcementId}`));
  assert.deepEqual(s.notifications.recover(), []); // 再恢复不重复
  assert.equal(new Set(sink).size, sink.length); // 实际发送无重复

  // 12) 扁肉随后复查通过并恢复；案件全部问题闭环
  s.compliance.recordReinspection({
    caseId,
    issueIds: [issueWonton],
    passed: true,
    inspector: roles.inspector2,
  });
  const finalRein = s.compliance.decideReinstatement({ caseId, decidedBy: roles.office });
  assert.equal(finalRein.caseClosed, true);

  // 12) 监管人员从任一入口看到完整链路与识别项
  const byStore = s.oversight.byStore("stall_1");
  const byEnf = s.oversight.byEnforcement(enf.enforcementId);
  assert.ok(byStore.findings.some((f) => f.code === "actual_operator_unlicensed"));
  const cStore = byStore.cases.find((c) => c.caseId === caseId);
  assert.equal(cStore.issues.length, 2);
  assert.equal(cStore.issues[0].evidence.length, 2);
  assert.equal(cStore.enforcement.find((e) => e.enforcementId === enf.enforcementId).appeal.status, "upheld");
  assert.equal(cStore.remediationSubmissions[0].reviews[0].reviewer.role, "brand_quality_reviewer");
  assert.equal(cStore.reinstatements.length, 2);
  // 两次恢复都只影响各自通过的范围
  assert.deepEqual(cStore.reinstatements[0].scope.categories, ["cat_noodle"]);
  assert.deepEqual(cStore.reinstatements[1].scope.categories, ["cat_wonton"]);
  // 处罚入口看到的案件集合与门店入口一致聚焦
  assert.ok(byEnf.cases.some((c) => c.caseId === caseId));
});

test("端到端：新实际经营者获批前持续无授权；获批后方可持证经营，旧主体责任仍可查", () => {
  const s = buildScenario();
  s.licensing.reportOperatorChange({
    storeId: "stall_1",
    previousOperatorId: "op_a",
    actualOperatorId: "op_c",
    actualOperatorName: "陈某",
  });
  let v = s.oversight.byStore("stall_1");
  assert.ok(v.findings.some((f) => f.code === "actual_operator_unlicensed"));

  // 新主体申请许可，需品牌办公室批准
  s.licensing.grantLicense({
    licenseId: "lic_c_new",
    brandId: "brand_mx",
    operatorId: "op_c",
    scope: { stores: ["stall_1"], categories: ["cat_noodle", "cat_wonton"] },
    standardVersionIds: ["std_v1"],
    grantedBy: roles.office,
  });
  // 未批准前仍标记无授权
  assert.ok(s.oversight.byStore("stall_1").findings.some((f) => f.code === "actual_operator_unlicensed"));
  s.licensing.decideApproval("lic_c_new", {
    role: "brand_office",
    decision: "approved",
    reviewer: roles.office,
  });
  v = s.oversight.byStore("stall_1");
  assert.ok(v.stores[0].currentLicensedOperators.includes("op_c"));

  // 旧主体许可仍可查、责任留存标记仍在
  const closed = s.licensing.view().licenses.get("lic_root");
  assert.equal(closed.status, "closed_by_change");
  assert.equal(closed.closure.responsibilityRetained, true);
});

test("事件信封契约：所有产出事件均符合基础字段与枚举约定", async () => {
  const s = buildScenario();
  const schema = JSON.parse(
    await (await import("node:fs/promises")).readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8")
  );
  const allowedEvents = new Set(schema.properties.event_type.enum);
  const allowedAggregates = new Set(schema.properties.aggregate_type.enum);
  for (const e of s.store.all()) {
    for (const field of ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"]) {
      assert.ok(field in e, `事件缺少 ${field}`);
    }
    assert.ok(allowedEvents.has(e.event_type), `未登记事件类型：${e.event_type}`);
    assert.ok(allowedAggregates.has(e.aggregate_type), `未登记聚合类型：${e.aggregate_type}`);
    assert.ok(Number.isInteger(e.version) && e.version >= 1);
  }
  // 事件类型目录与 schema 保持同步
  const { EventType: ET } = await import("../src/index.js");
  for (const name of Object.values(ET)) assert.ok(allowedEvents.has(name), `schema 缺少事件 ${name}`);
});
