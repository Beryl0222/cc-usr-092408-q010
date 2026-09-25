import assert from "node:assert/strict";
import test from "node:test";

import { suggestRisk } from "../src/risk.js";
import { buildWorld, T } from "./helpers/world.js";

// 建立：L0(s1, st1×面食+卤味) -> 批准转授 -> L1(s2, st1×面食)；档口 stall-A 现经营者 s2。
function chainWorld() {
  const g = buildWorld();
  g.auth.grantRoot(
    { licenseId: "L0", brandId: "b1", holderSubjectId: "s1", scope: { stores: ["st1"], categories: ["cat-noodle", "cat-snack"] }, standardVersionId: "std-v1", grantedAt: T.grant },
    "admin"
  );
  g.auth.requestSublicense(
    { requestId: "req1", parentLicenseId: "L0", toSubjectId: "s2", scope: { stores: ["st1"], categories: ["cat-noodle"] }, standardVersionId: "std-v1", requestedAt: "2026-03-01T00:00:00Z" },
    "admin"
  );
  g.auth.approveSublicense({ requestId: "req1", licenseId: "L1", approvedAt: "2026-03-02T00:00:00Z" }, "admin");
  g.register.changeStallOperator({ storeId: "st1", stallId: "stall-A", toSubjectId: "s1", changedAt: T.grant }, "admin");
  g.register.changeStallOperator({ storeId: "st1", stallId: "stall-A", toSubjectId: "s2", changedAt: "2026-08-01T00:00:00Z" }, "admin");
  return g;
}

function runCase(g, caseId = "c1") {
  const findings = [{ item: "生熟分开", detail: "熟食变质", severity: "critical", evidenceIds: ["ev1"] }];
  const evidence = [{ evidenceId: "ev1", type: "photo", content: { h: 1 }, collectedOffline: true }];
  g.cases.complain({ caseId, storeId: "st1", stallId: "stall-A", brandId: "b1", content: "异味", receivedAt: "2026-09-20T00:00:00Z" }, { subjectId: "s2" });
  const advisory = suggestRisk({ findings, evidence, standardVersionId: "std-v1" });
  g.cases.inspect({ caseId, inspectedAt: T.inspect, standardVersionId: "std-v1", findings, evidence, advisory }, "insp1");
  g.cases.confirmRisk({ caseId, confirmedLevel: "high", confirmedAt: T.inspect }, "insp1");
  g.cases.decide({ caseId, kind: "partial_stop_sale", licenseId: "L1", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: `sus-${caseId}` }, "insp1");
  g.cases.submitRemediation({ caseId, materials: [{ materialId: "m1", content: { doc: "报告" } }], submittedAt: "2026-09-24T00:00:00Z" }, { subjectId: "s2" });
  g.cases.review({ caseId, reviewId: `rv-${caseId}`, decision: "approved", reviewedAt: T.review }, "rev1");
}

test("处罚入口：看到完整授权链、适用标准、证据、申诉与恢复决定", () => {
  const g = chainWorld();
  runCase(g);
  const view = g.oversight.fromCase("c1");
  assert.equal(view.entry, "penalty");
  assert.deepEqual(view.case.licenseChain.map((l) => l.licenseId), ["L1", "L0"]);
  assert.equal(view.case.inspection.standard.standardVersionId, "std-v1");
  assert.equal(view.case.inspection.evidence[0].evidenceId, "ev1");
  assert.equal(view.case.review.decision, "approved");
  assert.deepEqual(view.case.review.restoreScope.categories, ["cat-noodle"]);
  assert.equal(view.case.licenseChain[0].status, "active"); // 复查后恢复
});

test("门店入口：穿透到档口实际经营者、历任主体与授权链", () => {
  const g = chainWorld();
  runCase(g);
  const view = g.oversight.fromStore("st1");
  assert.equal(view.entry, "store");
  const stall = view.stalls.find((s) => s.stallId === "stall-A");
  assert.equal(stall.operatorSubjectId, "s2");
  assert.deepEqual(stall.licenses, ["L1"]);
  // 历任主体时间线保留 s1 -> s2
  const subjects = view.operatorTimeline.filter((t) => t.stallId === "stall-A").flatMap((t) => [t.fromSubjectId, t.toSubjectId]).filter(Boolean);
  assert.deepEqual([...new Set(subjects)], ["s1", "s2"]);
  assert.ok(view.authorizationChains.some((chain) => chain.some((l) => l.licenseId === "L0")));
  assert.ok(view.cases.some((c) => c.caseId === "c1"));
});

test("品牌入口：聚合门店、授权链、适用标准与案件", () => {
  const g = chainWorld();
  runCase(g);
  const view = g.oversight.fromBrand("b1");
  assert.equal(view.entry, "brand");
  assert.ok(view.stores.some((s) => s.storeId === "st1"));
  const allLicenses = view.authorizationChains.flat().map((l) => l.licenseId);
  assert.ok(allLicenses.includes("L0") && allLicenses.includes("L1"));
  assert.ok(view.applicableStandards.some((s) => s.standardVersionId === "std-v1"));
  assert.ok(view.cases.some((c) => c.caseId === "c1"));
});

test("冲突识别：实际经营者变更但许可停留在原主体（穿透发现的错位）", () => {
  const g = chainWorld();
  // stall-A 从 s2 再转给无任何许可的 s3
  g.register.changeStallOperator({ storeId: "st1", stallId: "stall-A", toSubjectId: "s3", changedAt: "2026-09-10T00:00:00Z" }, "admin");
  const conflicts = g.oversight.detectConflicts();
  const stale = conflicts.filter((c) => c.type === "operator_license_stale");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].operatorSubjectId, "s3");
  // 门店与品牌入口都能看到该冲突
  assert.ok(g.oversight.fromStore("st1").conflicts.some((c) => c.type === "operator_license_stale"));
  assert.ok(g.oversight.fromBrand("b1").conflicts.some((c) => c.type === "operator_license_stale"));
});

test("冲突识别：越权转授（绕过正常批准的脏数据也能被只读模型发现）", () => {
  const g = chainWorld();
  // 直接追加一条超出上级范围的下级许可（正常服务会拒绝，这里模拟数据异常/历史遗留）
  g.store.append({
    eventType: "LICENSE_GRANTED",
    aggregateType: "license",
    aggregateId: "Lbad",
    payload: {
      licenseId: "Lbad",
      brandId: "b1",
      holderSubjectId: "s3",
      parentLicenseId: "L0",
      scope: { stores: ["st1", "st2"], categories: ["cat-noodle"] }, // st2 超出 L0
      standardVersionId: "std-v1",
      grantedAt: "2026-05-01T00:00:00Z",
      depth: 1,
    },
  });
  const overGrant = g.oversight.detectConflicts().filter((c) => c.type === "over_grant");
  assert.equal(overGrant.length, 1);
  assert.equal(overGrant[0].childLicenseId, "Lbad");
});

test("冲突识别：上级范围被暂停后，下级在该格点上失去有效来源", () => {
  const g = chainWorld();
  g.auth.suspend({ licenseId: "L0", scope: { stores: ["st1"], categories: ["cat-noodle"] }, caseId: "c-pre", reason: "调查", suspendedAt: "2026-06-01T00:00:00Z" }, "admin");
  const gap = g.oversight.detectConflicts().filter((c) => c.type === "ancestor_scope_gap");
  assert.equal(gap.length, 1);
  assert.equal(gap[0].childLicenseId, "L1");
  assert.deepEqual(gap[0].blockedScope.categories, ["cat-noodle"]);
});

test("冲突识别：并发复核（同一批材料出现两名复核人的结论）", () => {
  const g = chainWorld();
  runCase(g, "c2");
  // 正常流程乐观锁只允许一份；这里直接追加第二名复核人的结论，模拟绕过锁的并发写入
  g.store.append({
    eventType: "REVIEW_DECIDED",
    aggregateType: "case",
    aggregateId: "c2",
    payload: {
      reviewId: "rv-conflict",
      reviewerStaffId: "rev2",
      decision: "rejected",
      materialFingerprints: [g.cases.get("c2").review.materialFingerprints[0]],
      reviewedAt: "2026-09-25T01:00:00Z",
    },
  });
  const conflicts = g.oversight.detectConflicts().filter((c) => c.type === "concurrent_review_conflict");
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].reviewers.sort(), ["rev1", "rev2"]);
});

test("正常结案的案件不产生并发复核或食安措施误解除冲突", () => {
  const g = chainWorld();
  runCase(g);
  const types = g.oversight.detectConflicts().map((c) => c.type);
  assert.ok(!types.includes("concurrent_review_conflict"));
  assert.ok(!types.includes("safety_measure_lifted"));
});

test("处罚入口同时呈现申诉记录与食品安全措施状态", () => {
  const g = chainWorld();
  // 投诉、巡检、确认、局部停售
  const findings = [{ item: "生熟分开", detail: "变质", severity: "critical", evidenceIds: ["ev1"] }];
  const evidence = [{ evidenceId: "ev1", type: "photo", content: { h: 9 }, collectedOffline: true }];
  g.cases.complain({ caseId: "c3", storeId: "st1", stallId: "stall-A", brandId: "b1", content: "异味", receivedAt: "2026-09-20T00:00:00Z" }, { subjectId: "s2" });
  const advisory = suggestRisk({ findings, evidence });
  g.cases.inspect({ caseId: "c3", inspectedAt: T.inspect, standardVersionId: "std-v1", findings, evidence, advisory }, "insp1");
  g.cases.confirmRisk({ caseId: "c3", confirmedLevel: "high", confirmedAt: T.inspect }, "insp1");
  g.cases.decide({ caseId: "c3", kind: "partial_stop_sale", licenseId: "L1", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: "sus-c3" }, "insp1");
  g.cases.appeal({ appealId: "ap3", caseId: "c3", grounds: "有异议", filedAt: "2026-09-22T00:00:00Z" }, { subjectId: "s2" });
  g.cases.resolveAppeal({ appealId: "ap3", decision: "rejected", resolvedAt: "2026-09-23T00:00:00Z" }, "admin");

  const view = g.oversight.fromCase("c3");
  assert.equal(view.case.appeals.length, 1);
  assert.equal(view.case.appeals[0].status, "rejected");
  assert.equal(view.case.appeals[0].effect.liftsSafetyMeasure, false);
  // 措施仍在：链上 L1（仅面食）仍处于暂停
  const l1 = view.case.licenseChain.find((l) => l.licenseId === "L1");
  assert.equal(l1.status, "suspended");
  assert.ok(l1.suspensions.some((s) => s.caseId === "c3" && !s.fullyResumed));
});
