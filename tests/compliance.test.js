import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { suggestRisk } from "../src/risk.js";
import { buildWorld, T } from "./helpers/world.js";

// 搭好 s1 根许可（st1 两类），档口 stall-A 当前经营者 s1。
function licensedWorld(g = buildWorld()) {
  g.auth.grantRoot(
    { licenseId: "L0", brandId: "b1", holderSubjectId: "s1", scope: { stores: ["st1"], categories: ["cat-noodle", "cat-snack"] }, standardVersionId: "std-v1", grantedAt: T.grant },
    "admin"
  );
  g.register.changeStallOperator({ storeId: "st1", stallId: "stall-A", toSubjectId: "s1", changedAt: T.grant }, "admin");
  return g;
}

function complainAndInspect(g, { caseId = "c1", level, findings, evidence, inspectedAt = T.inspect, inspector = "insp1" } = {}) {
  g.cases.complain({ caseId, storeId: "st1", stallId: "stall-A", brandId: "b1", content: "消费者反映异味", receivedAt: "2026-09-20T00:00:00Z" }, { subjectId: "s1" });
  const advisory = suggestRisk({ findings, evidence, standardVersionId: "std-v1" });
  g.cases.inspect({ caseId, inspectedAt, standardVersionId: "std-v1", findings, evidence, advisory }, inspector);
  g.cases.confirmRisk({ caseId, confirmedLevel: level ?? advisory.suggestedLevel, confirmedAt: inspectedAt }, inspector);
  return advisory;
}

const criticalFinding = [{ item: "生熟分开", detail: "熟食变质、交叉污染", severity: "critical", evidenceIds: ["ev1"] }];
const photoEvidence = [{ evidenceId: "ev1", type: "photo", content: { hash: "abc" }, collectedOffline: true }];

test("自动风险分级仅供参考，须检查员确认后才能处置", () => {
  const g = licensedWorld();
  g.cases.complain({ caseId: "c1", storeId: "st1", stallId: "stall-A", content: "x", receivedAt: "2026-09-20T00:00:00Z" }, { subjectId: "s1" });
  const advisory = suggestRisk({ findings: criticalFinding, evidence: [], standardVersionId: "std-v1" });
  assert.equal(advisory.advisory, true);
  g.cases.inspect({ caseId: "c1", inspectedAt: T.inspect, standardVersionId: "std-v1", findings: criticalFinding, evidence: [], advisory }, "insp1");
  // 未确认风险不得处置
  assert.throws(() => g.cases.decide({ caseId: "c1", kind: "rectify", deadline: "2026-10-01T00:00:00Z", decidedAt: T.decide }, "insp1"), (e) => e.code === "RISK_NOT_CONFIRMED");
  // 检查员可以不采纳建议（建议 high，确认为 medium）
  g.cases.confirmRisk({ caseId: "c1", confirmedLevel: "medium", confirmedAt: T.inspect }, "insp1");
  const c = g.cases.get("c1");
  assert.equal(c.riskConfirmed.suggestedLevel, "high");
  assert.equal(c.riskConfirmed.acceptedSuggestion, false);
  assert.equal(c.riskConfirmed.confirmedLevel, "medium");
});

test("巡检绑定检查当时的标准版本快照与证据指纹，事后换版不改变依据", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: criticalFinding, evidence: photoEvidence });
  const c = g.cases.get("c1");
  assert.equal(c.inspection.standardSnapshot.standardVersionId, "std-v1");
  assert.equal(c.inspection.standardSnapshot.contentFingerprint, g.index().standard("std-v1").contentFingerprint);
  assert.ok(c.inspection.evidence[0].contentFingerprint.startsWith("sha256:"));

  // 之后发布新版并停用旧版
  g.register.standard({ standardVersionId: "std-v2", brandId: "b1", title: "出餐卫生标准", versionNo: "v2", effectiveFrom: "2026-10-01", items: [{ code: "H1", text: "生熟分开(更严)" }] }, "admin");
  g.register.supersedeStandard({ standardVersionId: "std-v1", supersededBy: "std-v2" }, "admin");
  // 案件里固化的仍是 v1 指纹
  assert.equal(g.cases.get("c1").inspection.standardSnapshot.versionNo, "v1");
});

test("局部停售只影响问题品类，不连带同一门店合规品类", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: criticalFinding, evidence: photoEvidence, level: "high" });
  g.cases.decide({ caseId: "c1", kind: "partial_stop_sale", licenseId: "L0", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: "sus-c1" }, "insp1");
  const license = g.auth.license("L0");
  assert.equal(license.status, "partially_suspended");
  assert.deepEqual(license.effectiveScope.categories, ["cat-snack"]); // 卤味仍可售
});

test("限期整改不需要停售许可范围", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: [{ item: "冷链温度", detail: "记录不全", severity: "minor" }], evidence: photoEvidence, level: "low" });
  g.cases.decide({ caseId: "c1", kind: "rectify", deadline: "2026-10-01T00:00:00Z", decidedAt: T.decide }, "insp1");
  assert.equal(g.cases.get("c1").status, "rectifying");
  assert.equal(g.auth.license("L0").status, "active");
});

test("暂停许可覆盖整个许可范围", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: criticalFinding, evidence: photoEvidence, level: "high" });
  g.cases.decide({ caseId: "c1", kind: "suspend_license", licenseId: "L0", reason: "严重", decidedAt: T.decide, suspensionId: "sus-c1" }, "insp1");
  assert.equal(g.auth.license("L0").status, "suspended");
});

test("申诉只冻结争议处罚，不解除食品安全措施", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: criticalFinding, evidence: photoEvidence, level: "high" });
  g.cases.decide({ caseId: "c1", kind: "partial_stop_sale", licenseId: "L0", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: "sus-c1" }, "insp1");
  g.cases.appeal({ appealId: "ap1", caseId: "c1", grounds: "不予认可", filedAt: "2026-09-22T00:00:00Z" }, { subjectId: "s1" });

  // 申诉期间停售措施仍在
  assert.equal(g.auth.license("L0").status, "partially_suspended");
  g.cases.resolveAppeal({ appealId: "ap1", decision: "upheld", resolvedAt: "2026-09-23T00:00:00Z" }, "admin");
  // 即便申诉成立，食品安全措施也不自动解除（需另行产生后继处置/恢复）
  assert.equal(g.auth.license("L0").status, "partially_suspended");
});

test("申诉只冻结争议处罚：限期整改被冻结，裁决后解除", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: [{ item: "冷链温度", detail: "记录不全", severity: "minor" }], evidence: photoEvidence, level: "low" });
  g.cases.decide({ caseId: "c1", kind: "rectify", deadline: "2026-10-01T00:00:00Z", decidedAt: T.decide }, "insp1");
  g.cases.appeal({ appealId: "ap1", caseId: "c1", grounds: "处罚过重", filedAt: "2026-09-22T00:00:00Z" }, { subjectId: "s1" });

  let c = g.cases.get("c1");
  assert.ok(c.activePenaltyHold, "争议处罚应处于冻结");
  assert.equal(c.activePenaltyHold.heldDisposition, "rectify");
  assert.equal(c.activePenaltyHold.safetyMeasureUnaffected, true);

  g.cases.resolveAppeal({ appealId: "ap1", decision: "rejected", resolvedAt: "2026-09-23T00:00:00Z" }, "admin");
  c = g.cases.get("c1");
  assert.equal(c.activePenaltyHold, null);
  assert.equal(c.heldPenalties[0].released.outcome, "penalty_resumed");
});

test("对局部停售的申诉不冻结食品安全措施", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: criticalFinding, evidence: photoEvidence, level: "high" });
  g.cases.decide({ caseId: "c1", kind: "partial_stop_sale", licenseId: "L0", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: "sus-c1" }, "insp1");
  g.cases.appeal({ appealId: "ap1", caseId: "c1", grounds: "否认", filedAt: "2026-09-22T00:00:00Z" }, { subjectId: "s1" });

  const c = g.cases.get("c1");
  assert.equal(c.activePenaltyHold, null); // 食安措施不冻结
  assert.equal(g.auth.license("L0").status, "partially_suspended");
});

test("整改材料须由另一角色复核，巡检人/处置人不能复核", () => {
  const g = licensedWorld();
  // 由同时具备检查员/复核员角色的人完成巡检与处置，再试图自己复核
  complainAndInspect(g, { findings: criticalFinding, evidence: photoEvidence, level: "high", inspector: "dual" });
  g.cases.decide({ caseId: "c1", kind: "partial_stop_sale", licenseId: "L0", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: "sus-c1" }, "dual");
  g.cases.submitRemediation({ caseId: "c1", materials: [{ materialId: "m1", content: { doc: "报告" } }], submittedAt: "2026-09-24T00:00:00Z" }, { subjectId: "s1" });
  // 同案巡检/处置人即便具备复核员角色也被职责分离拦截
  assert.throws(() => g.cases.review({ caseId: "c1", reviewId: "rv-x", decision: "approved", reviewedAt: T.review }, "dual"), (e) => e.code === "REVIEWER_CONFLICT");
  // 不具备复核员角色的检查员直接被角色拦截
  assert.throws(() => g.cases.review({ caseId: "c1", reviewId: "rv-y", decision: "approved", reviewedAt: T.review }, "insp1"), (e) => e.code === "FORBIDDEN");
  // 独立复核员可以复核
  g.cases.review({ caseId: "c1", reviewId: "rv1", decision: "approved", reviewedAt: T.review }, "rev1");
  assert.equal(g.cases.get("c1").status, "closed");
});

test("复核通过仅恢复受影响范围并关闭案件", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: criticalFinding, evidence: photoEvidence, level: "high" });
  g.cases.decide({ caseId: "c1", kind: "partial_stop_sale", licenseId: "L0", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: "sus-c1" }, "insp1");
  g.cases.submitRemediation({ caseId: "c1", materials: [{ materialId: "m1", content: { doc: "报告" } }], submittedAt: "2026-09-24T00:00:00Z" }, { subjectId: "s1" });
  g.cases.review({ caseId: "c1", reviewId: "rv1", decision: "approved", reviewedAt: T.review }, "rev1");
  assert.equal(g.cases.get("c1").status, "closed");
  assert.equal(g.auth.license("L0").status, "active");
  assert.deepEqual(g.auth.license("L0").effectiveScope.categories.sort(), ["cat-noodle", "cat-snack"]);
});

test("复核驳回则维持停售，可再次整改复核", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: criticalFinding, evidence: photoEvidence, level: "high" });
  g.cases.decide({ caseId: "c1", kind: "partial_stop_sale", licenseId: "L0", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: "sus-c1" }, "insp1");
  g.cases.submitRemediation({ caseId: "c1", materials: [{ materialId: "m1", content: { doc: "不充分" } }], submittedAt: "2026-09-24T00:00:00Z" }, { subjectId: "s1" });
  g.cases.review({ caseId: "c1", reviewId: "rv1", decision: "rejected", note: "证据不足", reviewedAt: T.review }, "rev1");
  assert.equal(g.auth.license("L0").status, "partially_suspended");
  assert.equal(g.cases.get("c1").status, "review_rejected");
  // 再次提交并通过
  g.cases.submitRemediation({ caseId: "c1", materials: [{ materialId: "m2", content: { doc: "已整改" } }], submittedAt: "2026-09-26T00:00:00Z" }, { subjectId: "s1" });
  g.cases.review({ caseId: "c1", reviewId: "rv2", decision: "approved", reviewedAt: "2026-09-27T00:00:00Z" }, "rev1");
  assert.equal(g.auth.license("L0").status, "active");
});

test("两名复核人并发提交，后提交者收到版本冲突且不产生恢复副作用", () => {
  const g = licensedWorld();
  complainAndInspect(g, { findings: criticalFinding, evidence: photoEvidence, level: "high" });
  g.cases.decide({ caseId: "c1", kind: "partial_stop_sale", licenseId: "L0", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: "sus-c1" }, "insp1");
  g.cases.submitRemediation({ caseId: "c1", materials: [{ materialId: "m1", content: { doc: "报告" } }], submittedAt: "2026-09-24T00:00:00Z" }, { subjectId: "s1" });
  const expectedVersion = g.store.history("c1").length;

  g.cases.review({ caseId: "c1", reviewId: "rv1", decision: "approved", reviewedAt: T.review, expectedVersion }, "rev1");
  assert.throws(
    () => g.cases.review({ caseId: "c1", reviewId: "rv2", decision: "approved", reviewedAt: T.review, expectedVersion }, "rev2"),
    (e) => e instanceof DomainError && e.code === "VERSION_CONFLICT"
  );
  // 只恢复过一次，范围完整恢复
  const resumeEvents = g.rawEvents().filter((e) => e.event_type === "LICENSE_RESUMED");
  assert.equal(resumeEvents.length, 1);
});

test("主体变更保留此前责任：检查当时经营者被锁定，历史主体不被改写", () => {
  const g = licensedWorld();
  // 8 月换经营者 s1 -> s2，但许可仍在 s1（投诉后穿透发现的错位）
  g.register.changeStallOperator({ storeId: "st1", stallId: "stall-A", toSubjectId: "s2", changedAt: "2026-08-01T00:00:00Z", note: "转让" }, "admin");
  g.cases.complain({ caseId: "c1", storeId: "st1", stallId: "stall-A", content: "x", receivedAt: "2026-09-20T00:00:00Z" }, { subjectId: "s2" });
  const advisory = suggestRisk({ findings: criticalFinding, evidence: photoEvidence });
  g.cases.inspect({ caseId: "c1", inspectedAt: T.inspect, standardVersionId: "std-v1", findings: criticalFinding, evidence: photoEvidence, advisory }, "insp1");
  const c = g.cases.get("c1");
  assert.equal(c.inspection.responsibleSubjectId, "s2"); // 当时实际经营者
  assert.deepEqual(c.inspection.historicalSubjectIds, ["s1", "s2"]); // 历任责任主体留档
});
