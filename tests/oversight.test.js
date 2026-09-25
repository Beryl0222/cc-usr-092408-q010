import assert from "node:assert/strict";
import test from "node:test";

import { Action, ErrorCode, RiskLevel } from "../src/index.js";
import { buildScenario, roles } from "./helpers.js";

// 构造一个含越权转授 + 主体变更 + 案件处置 + 复核冲突的丰富现场
function buildIncident() {
  const s = buildScenario();

  // 越权转授尝试：lic_sub_b 想把 stall_2 / 锅边 转授出去
  assert.throws(
    () =>
      s.licensing.grantLicense({
        licenseId: "lic_try_oob",
        brandId: "brand_mx",
        operatorId: "op_b",
        scope: { stores: ["stall_2"], categories: ["cat_noodle"] },
        parentLicenseId: "lic_sub_b",
        standardVersionIds: ["std_v1"],
        grantedBy: roles.operatorB,
      }),
    (e) => e.code === ErrorCode.SCOPE_EXCEEDED
  );

  // 投诉倒查发现实际经营者变更：op_a → op_c，旧许可关闭、责任留存
  s.licensing.reportOperatorChange({
    storeId: "stall_1",
    previousOperatorId: "op_a",
    actualOperatorId: "op_c",
    actualOperatorName: "陈某",
    discoveredVia: "complaint_trace",
  });

  // 立案（消费者投诉入口）
  const caseId = s.compliance.openCase({
    brandId: "brand_mx",
    storeId: "stall_1",
    source: "consumer_complaint",
    sourceRef: "投诉 20260925-007",
    openedBy: roles.office,
    title: "东街口档口冷链问题",
  });
  const issueId = s.compliance.recordIssue({
    caseId,
    standardVersionId: "std_v1",
    evidence: [{ type: "photo", contentHash: "ev_cold_1", uri: "oss://ev/cold1.jpg" }],
    severity: "high",
    foodSafetyCritical: true,
    scope: { stores: ["stall_1"], categories: ["cat_noodle"] },
    recordedBy: roles.inspector,
  });
  s.compliance.autoSuggest(caseId);
  s.compliance.confirmRisk(caseId, issueId, { risk: RiskLevel.HIGH, inspector: roles.inspector });
  const { enforcementId } = s.compliance.decideEnforcement({
    caseId,
    action: Action.PARTIAL_SUSPENSION,
    issueIds: [issueId],
    decidedBy: roles.inspector,
    note: "冷链断链",
  });
  return { s, caseId, issueId, enforcementId };
}

test("三入口（品牌 / 门店 / 处罚）看到同一份完整事实", () => {
  const { s, caseId, enforcementId } = buildIncident();

  const byBrand = s.oversight.byBrand("brand_mx");
  const byStore = s.oversight.byStore("stall_1");
  const byEnf = s.oversight.byEnforcement(enforcementId);

  for (const v of [byBrand, byStore, byEnf]) {
    // 授权链完整（含根许可与子许可）
    const ids = collectLicenseIds(v.authorizationChain.forest);
    assert.ok(ids.includes("lic_root"));
    assert.ok(ids.includes("lic_sub_b"));
    // 适用标准
    assert.ok(v.applicableStandards.some((x) => x.standardId === "std_v1"));
    // 案件、问题、证据
    const c = v.cases.find((x) => x.caseId === caseId);
    assert.equal(c.issues[0].evidence[0].contentHash, "ev_cold_1");
    assert.equal(c.issues[0].standard.versionNo, "v1.0");
    // 处置
    assert.equal(c.enforcement[0].enforcementId, enforcementId);
    assert.equal(c.enforcement[0].action, Action.PARTIAL_SUSPENSION);
    // 主体变更记录
    assert.ok(v.stores.some((st) => st.storeId === "stall_1" && st.actualOperatorChanges.length === 1));
  }
  assert.equal(byEnf.entrypoint.type, "enforcement");
  assert.equal(byStore.entrypoint.type, "store");
  assert.equal(byBrand.entrypoint.type, "brand");
});

test("监管视图识别越权转授与无授权实际经营", () => {
  const { s } = buildIncident();
  const v = s.oversight.byStore("stall_1");
  const codes = v.findings.map((f) => f.code);
  assert.ok(codes.includes("unauthorized_sublicense"), `缺少越权转授标记：${codes}`);
  assert.ok(codes.includes("actual_operator_unlicensed"), `缺少无授权实际经营标记：${codes}`);
  const oob = v.findings.find((f) => f.code === "unauthorized_sublicense");
  assert.deepEqual(oob.attemptedScope.stores, ["stall_2"]);
});

test("处罚入口呈现申诉与恢复决定", () => {
  const { s, caseId, enforcementId } = buildIncident();
  s.compliance.fileAppeal({
    caseId,
    enforcementId,
    reason: "冷链温度记录有争议",
    filedBy: roles.operatorB,
  });
  // 另一角色复核 + 复查通过 + 按范围恢复
  // 先把申诉驳回（维持处罚），进入整改流程
  s.compliance.decideAppeal({
    caseId,
    enforcementId,
    decision: "upheld",
    decidedBy: roles.reviewer2,
  });
  const submissionId = s.compliance.submitRemediation({
    caseId,
    issueIds: [s.compliance.view().cases.get(caseId).issues.keys().next().value],
    materials: [{ type: "report", contentHash: "mat_fix_1" }],
    submittedBy: roles.operatorB,
  });
  s.compliance.reviewRemediation({
    caseId,
    submissionId,
    result: "approved",
    reviewer: roles.reviewer,
  });
  s.compliance.recordReinspection({
    caseId,
    issueIds: [...s.compliance.view().cases.get(caseId).issues.keys()],
    passed: true,
    inspector: roles.inspector2,
  });
  const rein = s.compliance.decideReinstatement({ caseId, decidedBy: roles.office });

  const v = s.oversight.byEnforcement(enforcementId);
  const c = v.cases[0];
  assert.equal(c.enforcement[0].appeal.status, "upheld");
  assert.equal(c.remediationSubmissions[0].outcome, "approved");
  assert.equal(c.reinspections[0].passed, true);
  assert.equal(c.reinstatements[0].scope.stores.join(), rein.liftedScope.stores.join());
  // 恢复后许可限制解除
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").restrictions.length, 0);
});

test("入口标识不存在时抛出 NOT_FOUND", () => {
  const s = buildScenario();
  assert.throws(() => s.oversight.byStore("nope"), (e) => e.code === "NOT_FOUND");
  assert.throws(() => s.oversight.byEnforcement("enf_nope"), (e) => e.code === "NOT_FOUND");
});

test("品牌入口可覆盖多门店并隔离其他品牌（多品牌场景）", () => {
  const s = buildScenario();
  s.profiles.registerBrand({ brandId: "brand_other", name: "隔壁品牌", officeName: "x" });
  s.profiles.registerStore({ storeId: "stall_other", brandId: "brand_other", name: "他牌档口" });
  const v = s.oversight.byBrand("brand_mx");
  assert.deepEqual(v.stores.map((x) => x.storeId).sort(), ["stall_1", "stall_2"]);
  assert.ok(!v.stores.some((x) => x.storeId === "stall_other"));
});

function collectLicenseIds(nodes) {
  const out = [];
  for (const n of nodes) {
    out.push(n.licenseId);
    out.push(...collectLicenseIds(n.children));
  }
  return out;
}
