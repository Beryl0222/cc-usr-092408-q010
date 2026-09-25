import assert from "node:assert/strict";
import test from "node:test";

import { Action, ErrorCode, RiskLevel } from "../src/index.js";
import { buildScenario, roles } from "./helpers.js";

const NOODLE_SCOPE = { stores: ["stall_1"], categories: ["cat_noodle"] };
const WONTON_SCOPE = { stores: ["stall_1"], categories: ["cat_wonton"] };
const BOTH_SCOPE = { stores: ["stall_1"], categories: ["cat_noodle", "cat_wonton"] };

function openCaseWithIssue(s, overrides = {}) {
  const caseId = s.compliance.openCase({
    brandId: "brand_mx",
    storeId: "stall_1",
    source: overrides.source ?? "consumer_complaint",
    sourceRef: "投诉单 20260925-001",
    openedBy: roles.office,
    title: overrides.title ?? "东街口档口卫生问题",
  });
  const issueId = s.compliance.recordIssue({
    caseId,
    standardVersionId: "std_v1",
    evidence: [
      { type: "photo", contentHash: "hash_photo_1", uri: "oss://ev/1.jpg", collectedBy: roles.inspector },
      { type: "note", contentHash: "hash_note_1", collectedBy: roles.inspector },
    ],
    severity: overrides.severity ?? "high",
    foodSafetyCritical: overrides.foodSafetyCritical ?? true,
    scope: overrides.scope ?? NOODLE_SCOPE,
    recordedBy: roles.inspector,
  });
  return { caseId, issueId };
}

function confirm(s, caseId, issueId, risk = RiskLevel.HIGH, inspector = roles.inspector) {
  s.compliance.confirmRisk(caseId, issueId, { risk, inspector });
}

test("问题绑定检查当时的标准版本、证据与责任主体快照", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s);

  // 事后标准换版/废止，不改变问题绑定
  s.profiles.deprecateStandard("std_v1", { reason: "换版" });

  const c = s.compliance.view().cases.get(caseId);
  const issue = c.issues.get(issueId);
  assert.equal(issue.standardVersionId, "std_v1");
  assert.equal(issue.evidence.length, 2);
  assert.equal(issue.evidence[0].contentHash, "hash_photo_1");
  assert.deepEqual([...issue.operatorIdAtCheck].sort(), ["op_a", "op_b"]);
  assert.equal(issue.recordedBy.id, "u_insp1");
});

test("自动风险分级仅为建议：未确认前不得处置；检查员可以改判", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s, { severity: "low", foodSafetyCritical: false });
  s.compliance.autoSuggest(caseId);
  const issue0 = s.compliance.view().cases.get(caseId).issues.get(issueId);
  assert.equal(issue0.suggestedRisk, RiskLevel.LOW);
  assert.equal(issue0.confirmedRisk, null);

  assert.throws(
    () =>
      s.compliance.decideEnforcement({
        caseId,
        action: Action.LICENSE_PAUSE,
        issueIds: [issueId],
        decidedBy: roles.inspector,
      }),
    (e) => e.code === ErrorCode.INVALID_STATE
  );

  // 检查员改判为高风险
  s.compliance.confirmRisk(caseId, issueId, { risk: RiskLevel.HIGH, inspector: roles.inspector });
  const issue1 = s.compliance.view().cases.get(caseId).issues.get(issueId);
  assert.equal(issue1.confirmedRisk, RiskLevel.HIGH);

  const v = s.oversight.byStore("stall_1");
  const theCase = v.cases.find((c) => c.caseId === caseId);
  assert.equal(theCase.issues[0].riskOverridden, true);
});

test("限期整改必须给截止时间；到期前不产生升级", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s, { scope: NOODLE_SCOPE });
  confirm(s, caseId, issueId);
  assert.throws(
    () =>
      s.compliance.decideEnforcement({
        caseId,
        action: Action.RECTIFY_WITH_DEADLINE,
        issueIds: [issueId],
        decidedBy: roles.inspector,
      }),
    (e) => e.code === ErrorCode.INVALID_ARGUMENT
  );
  const { enforcementId } = s.compliance.decideEnforcement({
    caseId,
    action: Action.RECTIFY_WITH_DEADLINE,
    issueIds: [issueId],
    deadline: "2026-09-28T18:00:00+08:00",
    decidedBy: roles.inspector,
  });
  assert.ok(enforcementId);
  // 立即派发：只有处置通知；逾期升级尚未到期
  const sent = s.notifications.dispatchDue({ now: "2026-09-25T20:00:00+08:00" });
  assert.deepEqual(sent, [`action_notice:${enforcementId}`]);
});

test("局部停售仅限制涉事品类，同一门店合规品类继续经营", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s, { scope: NOODLE_SCOPE });
  confirm(s, caseId, issueId);
  const { restrictedLicenses } = s.compliance.decideEnforcement({
    caseId,
    action: Action.PARTIAL_SUSPENSION,
    issueIds: [issueId],
    decidedBy: roles.inspector,
    note: "拌面冷链票据缺失",
  });
  // 覆盖该门店的两条许可都只被限制到 cat_noodle
  assert.equal(restrictedLicenses.length, 2);
  for (const { scope } of restrictedLicenses) {
    assert.deepEqual(scope.categories, ["cat_noodle"]);
  }
  const subB = s.licensing.view().licenses.get("lic_sub_b");
  assert.equal(subB.status, "active"); // 许可本身有效，仅范围受限
  assert.deepEqual(subB.restrictions[0].scope.categories, ["cat_noodle"]);
  assert.equal(subB.restrictions[0].foodSafetyMeasure, true);
});

test("申诉只冻结争议处罚，不解除食品安全措施", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s);
  confirm(s, caseId, issueId);
  const { enforcementId } = s.compliance.decideEnforcement({
    caseId,
    action: Action.PARTIAL_SUSPENSION,
    issueIds: [issueId],
    decidedBy: roles.inspector,
  });
  const restrictionsBefore = s.licensing.view().licenses.get("lic_sub_b").restrictions.length;

  s.compliance.fileAppeal({
    caseId,
    enforcementId,
    reason: "证据时间存疑",
    filedBy: roles.operatorB,
  });
  const c = s.compliance.view().cases.get(caseId);
  const enf = c.enforcement[0];
  assert.equal(enf.frozenByAppeal, true);
  assert.equal(enf.appeal.status, "pending");
  // 许可上的停售措施一条不少
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").restrictions.length, restrictionsBefore);
  // 处置通知被挂起
  const n = s.notifications.view().notifications.get(`action_notice:${enforcementId}`);
  assert.equal(n.status, "held");

  // 申诉成立（撤销处罚）：取消挂起通知，但食品安全措施仍不自动解除
  s.compliance.decideAppeal({
    caseId,
    enforcementId,
    decision: "overturned",
    detail: "证据不足",
    decidedBy: roles.reviewer2,
  });
  assert.equal(
    s.notifications.view().notifications.get(`action_notice:${enforcementId}`).status,
    "cancelled"
  );
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").restrictions.length, restrictionsBefore);

  const v = s.oversight.byStore("stall_1");
  const appealed = v.cases.find((x) => x.caseId === caseId).enforcement[0];
  assert.equal(appealed.appeal.status, "overturned");
});

test("整改材料须另一角色复核：提交人与记录检查员均不得复核", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s);
  confirm(s, caseId, issueId);
  s.compliance.decideEnforcement({
    caseId,
    action: Action.RECTIFY_WITH_DEADLINE,
    issueIds: [issueId],
    deadline: "2026-09-28T18:00:00+08:00",
    decidedBy: roles.inspector,
  });
  const submissionId = s.compliance.submitRemediation({
    caseId,
    issueIds: [issueId],
    materials: [{ type: "photo", contentHash: "mat_1", uri: "oss://mat/1.jpg" }],
    submittedBy: roles.operatorB,
  });

  assert.throws(
    () =>
      s.compliance.reviewRemediation({
        caseId,
        submissionId,
        result: "approved",
        reviewer: roles.operatorB, // 提交人本人
      }),
    (e) => e.code === ErrorCode.INVALID_STATE
  );
  assert.throws(
    () =>
      s.compliance.reviewRemediation({
        caseId,
        submissionId,
        result: "approved",
        reviewer: roles.inspector, // 当初记录问题的检查员
      }),
    (e) => e.code === ErrorCode.INVALID_STATE
  );

  // 另一角色复核通过
  s.compliance.reviewRemediation({
    caseId,
    submissionId,
    result: "approved",
    reviewer: roles.reviewer,
    note: "材料齐全",
  });
  const sub = s.compliance.view().cases.get(caseId).remediationSubmissions[0];
  assert.equal(sub.outcome, "approved");
});

test("并发复核结论冲突：双方意见都留痕、标记冲突并阻断恢复，裁定后才可继续", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s);
  confirm(s, caseId, issueId);
  s.compliance.decideEnforcement({
    caseId,
    action: Action.PARTIAL_SUSPENSION,
    issueIds: [issueId],
    decidedBy: roles.inspector,
  });
  const submissionId = s.compliance.submitRemediation({
    caseId,
    issueIds: [issueId],
    materials: [{ type: "photo", contentHash: "mat_1" }],
    submittedBy: roles.operatorB,
  });
  const versionBefore = s.store.versionOf(caseId);

  // 复核人甲：通过
  s.compliance.reviewRemediation({
    caseId,
    submissionId,
    result: "approved",
    reviewer: roles.reviewer,
  });
  // 复核人乙基于过期视图提交相反结论
  assert.throws(
    () =>
      s.compliance.reviewRemediation({
        caseId,
        submissionId,
        result: "rejected",
        reviewer: roles.reviewer2,
        expectedCaseVersion: versionBefore,
      }),
    (e) => e.code === ErrorCode.REVIEW_CONFLICT
  );

  const c = s.compliance.view().cases.get(caseId);
  assert.equal(c.reviewConflicts.length, 1);
  assert.equal(c.reviewConflicts[0].status, "open");
  assert.equal(c.remediationSubmissions[0].reviews.length, 2); // 两种意见均保留

  // 未裁定前禁止恢复
  s.compliance.recordReinspection({
    caseId,
    issueIds: [issueId],
    passed: true,
    inspector: roles.inspector2,
  });
  assert.throws(() => s.compliance.decideReinstatement({ caseId, decidedBy: roles.office }), (e) =>
    e.code === ErrorCode.INVALID_STATE
  );

  // 监管视图可见冲突
  const v = s.oversight.byStore("stall_1");
  assert.ok(v.findings.some((f) => f.code === "concurrent_review_conflict_open"));

  // 裁定
  s.compliance.adjudicateReviewConflict({
    caseId,
    conflictId: c.reviewConflicts[0].conflictId,
    winningResult: "approved",
    decidedBy: roles.office,
  });
  const after = s.compliance.decideReinstatement({ caseId, decidedBy: roles.office });
  assert.ok(after.reinstatementId);
  const v2 = s.oversight.byStore("stall_1");
  assert.ok(v2.findings.some((f) => f.code === "concurrent_review_conflict_resolved"));
});

test("复查通过仅恢复受影响（且通过）的范围，未通过部分继续停售", () => {
  const s = buildScenario();
  const caseId = s.compliance.openCase({
    brandId: "brand_mx",
    storeId: "stall_1",
    openedBy: roles.office,
  });
  const iNoodle = s.compliance.recordIssue({
    caseId,
    standardVersionId: "std_v1",
    evidence: [{ type: "photo", contentHash: "ev_n" }],
    severity: "high",
    foodSafetyCritical: true,
    scope: NOODLE_SCOPE,
    recordedBy: roles.inspector,
  });
  const iWonton = s.compliance.recordIssue({
    caseId,
    standardVersionId: "std_v1",
    evidence: [{ type: "photo", contentHash: "ev_w" }],
    severity: "medium",
    foodSafetyCritical: true,
    scope: WONTON_SCOPE,
    recordedBy: roles.inspector,
  });
  confirm(s, caseId, iNoodle);
  confirm(s, caseId, iWonton);
  s.compliance.decideEnforcement({
    caseId,
    action: Action.PARTIAL_SUSPENSION,
    issueIds: [iNoodle, iWonton],
    decidedBy: roles.inspector,
  });
  // 根许可覆盖两品类 → 其限制含两者；子许可 lic_sub_b 只覆盖拌面 → 只限制拌面
  const root = () => s.licensing.view().licenses.get("lic_root");
  const subB = () => s.licensing.view().licenses.get("lic_sub_b");
  assert.deepEqual([...root().restrictions[0].scope.categories].sort(), ["cat_noodle", "cat_wonton"]);
  assert.deepEqual([...subB().restrictions[0].scope.categories], ["cat_noodle"]);

  // 仅拌面问题整改、复核、复查通过
  const submissionId = s.compliance.submitRemediation({
    caseId,
    issueIds: [iNoodle],
    materials: [{ type: "zip", contentHash: "mat_n" }],
    submittedBy: roles.operatorB,
  });
  s.compliance.reviewRemediation({ caseId, submissionId, result: "approved", reviewer: roles.reviewer });
  s.compliance.recordReinspection({
    caseId,
    issueIds: [iNoodle],
    passed: true,
    inspector: roles.inspector2,
  });

  const result = s.compliance.decideReinstatement({ caseId, decidedBy: roles.office });
  assert.deepEqual(result.liftedScope.categories, ["cat_noodle"]);

  // 扁肉仍在根许可上停售；子许可的拌面限制已整体解除
  const rootRemaining = root().restrictions;
  assert.equal(rootRemaining.length, 1);
  assert.deepEqual(rootRemaining[0].scope.categories, ["cat_wonton"]);
  assert.deepEqual(subB().restrictions, []);

  // 案件序列化保留复查与恢复决定
  const c = s.oversight.byStore("stall_1").cases.find((x) => x.caseId === caseId);
  assert.equal(c.reinspections[0].passed, true);
  assert.deepEqual(c.reinstatements[0].scope.categories, ["cat_noodle"]);
});

test("暂停许可使许可整体进入 paused；复查通过后恢复 active，不影响其他主体许可", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s, { scope: BOTH_SCOPE });
  confirm(s, caseId, issueId);
  s.compliance.decideEnforcement({
    caseId,
    action: Action.LICENSE_PAUSE,
    issueIds: [issueId],
    decidedBy: roles.inspector,
  });
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").status, "paused");
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").restrictions[0].mode, "license_pause");

  const submissionId = s.compliance.submitRemediation({
    caseId,
    issueIds: [issueId],
    materials: [{ type: "report", contentHash: "m1" }],
    submittedBy: roles.operatorB,
  });
  s.compliance.reviewRemediation({ caseId, submissionId, result: "approved", reviewer: roles.reviewer });
  s.compliance.recordReinspection({ caseId, issueIds: [issueId], passed: true, inspector: roles.inspector2 });
  s.compliance.decideReinstatement({ caseId, decidedBy: roles.office });
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").status, "active");
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").restrictions.length, 0);
});

test("复查不通过时不得恢复", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s);
  confirm(s, caseId, issueId);
  s.compliance.decideEnforcement({
    caseId,
    action: Action.PARTIAL_SUSPENSION,
    issueIds: [issueId],
    decidedBy: roles.inspector,
  });
  const submissionId = s.compliance.submitRemediation({
    caseId,
    issueIds: [issueId],
    materials: [{ type: "photo", contentHash: "mat_1" }],
    submittedBy: roles.operatorB,
  });
  s.compliance.reviewRemediation({ caseId, submissionId, result: "approved", reviewer: roles.reviewer });
  s.compliance.recordReinspection({
    caseId,
    issueIds: [issueId],
    passed: false,
    inspector: roles.inspector2,
  });
  assert.throws(() => s.compliance.decideReinstatement({ caseId, decidedBy: roles.office }), (e) =>
    e.code === ErrorCode.INVALID_STATE
  );
});

test("主体变更不改变历史问题的责任主体快照", () => {
  const s = buildScenario();
  const { caseId, issueId } = openCaseWithIssue(s);
  s.licensing.reportOperatorChange({
    storeId: "stall_1",
    previousOperatorId: "op_a",
    actualOperatorId: "op_c",
    actualOperatorName: "陈某",
  });
  const issue = s.compliance.view().cases.get(caseId).issues.get(issueId);
  assert.deepEqual([...issue.operatorIdAtCheck].sort(), ["op_a", "op_b"]);
});
