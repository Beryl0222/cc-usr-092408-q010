import { randomUUID } from "node:crypto";
import {
  Aggregate,
  Action,
  LicenseStatus,
  RiskLevel,
  intersectScope,
  isEmptyScope,
  mergeScope,
  suggestRisk,
} from "../domain/constants.js";
import { EventType } from "../domain/event-types.js";
import { ErrorCode, fail } from "../domain/errors.js";
import { Projection } from "../domain/projection.js";
import { newId } from "./profiles.js";

// 巡检与处置服务。
// 关键规则：
//  - 问题绑定检查当时的标准版本与证据（快照），标准换版不改写历史；
//  - 自动风险分级仅供检查员参考，必须人工确认后才能处置；
//  - 处置三选一：限期整改 / 局部停售 / 暂停许可；
//  - 申诉只冻结争议处罚，食品安全措施不解除；
//  - 整改材料必须由另一角色复核，并发复核结论冲突时显式标记；
//  - 复查通过仅恢复受影响且已通过的范围。
export class ComplianceService {
  constructor(store, clock, notifications) {
    this.store = store;
    this.clock = clock;
    this.notifications = notifications; // NotificationService（可为空）
  }

  view() {
    return Projection.fromEvents(this.store.all());
  }

  openCase({ caseId = newId("case"), brandId, storeId, source = "inspection", sourceRef = null, openedBy, title }) {
    if (this.store.versionOf(caseId) > 0) fail(ErrorCode.ALREADY_EXISTS, `案件已存在：${caseId}`);
    const view = this.view();
    if (!view.brands.has(brandId)) fail(ErrorCode.NOT_FOUND, `品牌未建档：${brandId}`);
    if (!view.stores.has(storeId)) fail(ErrorCode.NOT_FOUND, `门店未建档：${storeId}`);
    this.store.append({
      event_type: EventType.CASE_OPENED,
      aggregate_type: Aggregate.CASE,
      aggregate_id: caseId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `立案：${title ?? sourceRef ?? storeId}（来源：${source}）`,
      payload: { brandId, storeId, source, sourceRef, openedBy },
    });
    return caseId;
  }

  // 记录问题。standardVersionId 是检查当时生效标准的快照绑定，事后不得改写。
  recordIssue(input) {
    const {
      caseId,
      issueId = newId("issue"),
      standardVersionId,
      evidence = [],
      severity = "medium",
      foodSafetyCritical = false,
      scope,
      recordedBy,
    } = input;
    const expected = this.store.versionOf(caseId);
    if (expected === 0) fail(ErrorCode.NOT_FOUND, `案件不存在：${caseId}`);
    const view = this.view();
    const standard = view.standards.get(standardVersionId);
    if (!standard) fail(ErrorCode.NOT_FOUND, `检查所依据的标准版本不存在：${standardVersionId}`);
    const c = view.cases.get(caseId);
    if (c.issues.has(issueId)) fail(ErrorCode.ALREADY_EXISTS, `问题已存在：${issueId}`);
    if (isEmptyScope(scope)) fail(ErrorCode.INVALID_ARGUMENT, "问题必须指明涉及的门店/品类范围");

    // 责任主体快照：以检查当时覆盖该门店的有效许可持有人为准；主体变更后仍向其追责。
    const holders = [...view.licenses.values()]
      .filter((l) => l.status === LicenseStatus.ACTIVE && l.scope.stores.includes(c.storeId))
      .map((l) => l.holderOperatorId);
    const operatorIdAtCheck = input.operatorIdAtCheck ?? [...new Set(holders)];

    const ev = evidence.map((e) => ({
      evidenceId: e.evidenceId ?? `ev_${randomUUID().slice(0, 8)}`,
      type: e.type,
      contentHash: e.contentHash ?? e.hash ?? null,
      uri: e.uri ?? null,
      capturedAt: e.capturedAt ?? this.clock.now(),
      collectedBy: e.collectedBy ?? recordedBy,
    }));

    this.store.append(
      {
        event_type: EventType.ISSUE_RECORDED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `记录问题 ${issueId}（依据标准 ${standardVersionId}${foodSafetyCritical ? "，食品安全关键项" : ""}）`,
        payload: {
          caseId,
          issueId,
          standardVersionId,
          evidence: ev,
          severity,
          foodSafetyCritical,
          scope,
          operatorIdAtCheck,
          recordedBy,
        },
      },
      expected
    );
    return issueId;
  }

  // 系统自动分级：只产生“建议”，不驱动任何处置。
  autoSuggest(caseId) {
    const c = this.view().cases.get(caseId);
    if (!c) fail(ErrorCode.NOT_FOUND, `案件不存在：${caseId}`);
    let count = 0;
    for (const issue of c.issues.values()) {
      if (issue.confirmedRisk || issue.suggestedRisk) continue;
      const risk = suggestRisk([{ severity: issue.severity, foodSafetyCritical: issue.foodSafetyCritical }]);
      this.store.append(
        {
          event_type: EventType.RISK_SUGGESTED,
          aggregate_type: Aggregate.CASE,
          aggregate_id: caseId,
          occurred_at: this.clock.now(),
          summary: `系统建议风险分级：${issue.issueId} → ${risk}（仅供参考）`,
          payload: { caseId, issueId: issue.issueId, risk, automated: true },
        },
        this.store.versionOf(caseId)
      );
      count += 1;
    }
    return count;
  }

  // 检查员确认分级，可以采纳或改判建议。
  confirmRisk(caseId, issueId, { risk, inspector }) {
    if (!Object.values(RiskLevel).includes(risk)) fail(ErrorCode.INVALID_ARGUMENT, `未知风险等级：${risk}`);
    const expected = this.store.versionOf(caseId);
    const c = this.view().cases.get(caseId);
    const issue = c?.issues.get(issueId);
    if (!issue) fail(ErrorCode.NOT_FOUND, `问题不存在：${issueId}`);
    if (issue.confirmedRisk) fail(ErrorCode.INVALID_STATE, `问题 ${issueId} 已确认分级`);
    this.store.append(
      {
        event_type: EventType.RISK_CONFIRMED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `检查员确认风险分级：${issueId} → ${risk}${issue.suggestedRisk && issue.suggestedRisk !== risk ? `（改判，系统建议为 ${issue.suggestedRisk}）` : ""}`,
        payload: { caseId, issueId, risk, inspector, suggestedRisk: issue.suggestedRisk },
      },
      expected
    );
  }

  // 处置决定。action 三选一；局部停售/暂停许可同步在相关许可上施加范围限制。
  decideEnforcement(input) {
    const { caseId, action, scope, issueIds, decidedBy, deadline = null, note = "" } = input;
    const expected = this.store.versionOf(caseId);
    const view = this.view();
    const c = view.cases.get(caseId);
    if (!c) fail(ErrorCode.NOT_FOUND, `案件不存在：${caseId}`);
    if (!Object.values(Action).includes(action)) fail(ErrorCode.INVALID_ARGUMENT, `未知处置类型：${action}`);
    const ids = issueIds ?? [...c.issues.keys()];
    if (!ids.length) fail(ErrorCode.INVALID_STATE, "案件没有可处置的问题");
    for (const id of ids) {
      const issue = c.issues.get(id);
      if (!issue) fail(ErrorCode.NOT_FOUND, `问题不存在：${id}`);
      if (!issue.confirmedRisk) fail(ErrorCode.INVALID_STATE, `问题 ${id} 尚未经检查员确认风险分级，不得处置`);
    }
    if (action === Action.RECTIFY_WITH_DEADLINE && !deadline) {
      fail(ErrorCode.INVALID_ARGUMENT, "限期整改必须给出截止时间");
    }
    const affectedScope = scope
      ? { stores: [...(scope.stores ?? [])], categories: [...(scope.categories ?? [])] }
      : unionScope(c, ids);
    if (isEmptyScope(affectedScope)) fail(ErrorCode.INVALID_ARGUMENT, "处置范围为空");
    const foodSafetyMeasure = ids.some((id) => c.issues.get(id).foodSafetyCritical) ||
      action !== Action.RECTIFY_WITH_DEADLINE; // 停售/暂停本身即食品安全保障措施

    const enforcementId = newId("enf");
    this.store.append(
      {
        event_type: EventType.ENFORCEMENT_DECIDED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: enforcementSummary(action, affectedScope, ids),
        payload: {
          caseId,
          enforcementId,
          action,
          scope: affectedScope,
          issueIds: ids,
          deadline,
          foodSafetyMeasure,
          decidedBy,
          note,
        },
      },
      expected
    );

    // 局部停售 / 暂停许可：在所有覆盖该门店且处于有效状态的许可上施加范围限制。
    // 限制携带案件与问题标识，恢复时只能解除与之对应的部分。
    const restrictionId = newId("rest");
    const restrictedLicenses = [];
    if (action !== Action.RECTIFY_WITH_DEADLINE) {
      for (const lic of view.licenses.values()) {
        if (lic.status !== LicenseStatus.ACTIVE) continue;
        if (!affectedScope.stores.some((s) => lic.scope.stores.includes(s))) continue;
        const piece = intersectScope(lic.scope, affectedScope);
        if (isEmptyScope(piece)) continue;
        const licVersion = this.store.versionOf(lic.licenseId);
        this.store.append(
          {
            event_type: EventType.LICENSE_SCOPE_SUSPENDED,
            aggregate_type: Aggregate.LICENSE,
            aggregate_id: lic.licenseId,
            occurred_at: this.clock.now(),
            summary:
              action === Action.PARTIAL_SUSPENSION
                ? `局部停售：${piece.categories.join("、") || "指定品类"}（案件 ${caseId}）`
                : `暂停许可（案件 ${caseId}）`,
            payload: {
              restrictionId: `${restrictionId}_${lic.licenseId}`,
              mode: action === Action.LICENSE_PAUSE ? "license_pause" : "partial_suspension",
              scope: piece,
              reason: note,
              caseId,
              enforcementId,
              issueIds: ids,
              foodSafetyMeasure: true,
            },
          },
          licVersion
        );
        restrictedLicenses.push({ licenseId: lic.licenseId, scope: piece });
      }
    }

    this.#scheduleEnforcementNotifications({ caseId, enforcementId, action, affectedScope, deadline, c });
    return { enforcementId, restrictionId, restrictedLicenses };
  }

  #scheduleEnforcementNotifications({ caseId, enforcementId, action, affectedScope, deadline, c }) {
    if (!this.notifications) return;
    const target = { storeId: c.storeId };
    this.notifications.schedule({
      key: `action_notice:${enforcementId}`,
      kind: "action_notice",
      channel: "operator",
      target,
      scheduledFor: this.clock.now(),
      payload: { caseId, enforcementId, action, scope: affectedScope },
    });
    if (action === Action.RECTIFY_WITH_DEADLINE && deadline) {
      this.notifications.schedule({
        key: `deadline_reminder:${enforcementId}`,
        kind: "deadline_reminder",
        channel: "operator",
        target,
        scheduledFor: this.clock.now(), // 实际发送时间由到期判定控制
        payload: { caseId, enforcementId, deadline, fireAt: deadline },
      });
      // 逾期升级：若到期未闭环则升级；中断期间到期的，在恢复时补齐，且只执行一次。
      this.notifications.schedule({
        key: `risk_escalation:${enforcementId}`,
        kind: "risk_escalation",
        channel: "brand_office",
        target: { brandId: c.brandId },
        scheduledFor: deadline,
        payload: { caseId, enforcementId, caseStoreId: c.storeId, reason: "整改逾期" },
      });
    }
  }

  // 申诉：冻结争议处罚（相关通知挂起、不继续执行非食品安全处罚），
  // 但许可上的停售/暂停等食品安全措施一律保持有效。
  fileAppeal({ caseId, enforcementId, reason, filedBy }) {
    const expected = this.store.versionOf(caseId);
    const c = this.view().cases.get(caseId);
    const enf = c?.enforcement.find((e) => e.enforcementId === enforcementId);
    if (!enf) fail(ErrorCode.NOT_FOUND, `处置决定不存在：${enforcementId}`);
    if (enf.appeal?.status === "pending") fail(ErrorCode.INVALID_STATE, "该处罚已在申诉中");
    this.store.append(
      {
        event_type: EventType.APPEAL_FILED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `提起申诉：${enforcementId}（争议处罚冻结，食品安全措施继续有效）`,
        payload: { caseId, enforcementId, reason, filedBy },
      },
      expected
    );
    // 挂起该处罚的非食品安全类通知（到期提醒、逾期升级）；处置通知若未发送也一并挂起。
    // 食品安全措施（许可限制）不在此处解除。
    this.notifications?.holdByAppeal(enforcementId, { reason: `申诉中：${reason}` });
  }

  decideAppeal({ caseId, enforcementId, decision, detail, decidedBy }) {
    if (!["upheld", "overturned", "adjusted"].includes(decision)) {
      fail(ErrorCode.INVALID_ARGUMENT, "申诉决定须为 upheld / overturned / adjusted");
    }
    const expected = this.store.versionOf(caseId);
    const c = this.view().cases.get(caseId);
    const enf = c?.enforcement.find((e) => e.enforcementId === enforcementId);
    if (!enf?.appeal || enf.appeal.status !== "pending") {
      fail(ErrorCode.INVALID_STATE, "该处罚没有待决申诉");
    }
    this.store.append(
      {
        event_type: EventType.APPEAL_DECIDED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `申诉决定：${enforcementId} → ${decision}`,
        payload: { caseId, enforcementId, decision, detail, decidedBy },
      },
      expected
    );
    if (decision === "overturned") {
      // 撤销处罚：取消挂起的升级/提醒；食品安全措施是否解除由复查/恢复流程决定，这里不自动解除。
      this.notifications?.cancelByEnforcement(enforcementId);
    } else {
      // upheld / adjusted：挂起的通知重新排期，恢复后按幂等键补发，不会重复。
      this.notifications?.resumeByAppeal(enforcementId, this.clock.now());
    }
  }

  submitRemediation({ caseId, issueIds, materials, submittedBy, submissionId = newId("remed") }) {
    const expected = this.store.versionOf(caseId);
    const c = this.view().cases.get(caseId);
    if (!c) fail(ErrorCode.NOT_FOUND, `案件不存在：${caseId}`);
    const ids = issueIds ?? [...c.issues.keys()];
    for (const id of ids) {
      if (!c.issues.has(id)) fail(ErrorCode.NOT_FOUND, `问题不存在：${id}`);
    }
    if (!materials?.length) fail(ErrorCode.INVALID_ARGUMENT, "整改材料不能为空");
    this.store.append(
      {
        event_type: EventType.REMEDIATION_SUBMITTED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `整改材料提交：${submissionId}（问题 ${ids.length} 项）`,
        payload: {
          caseId,
          submissionId,
          issueIds: ids,
          materials: materials.map((m) => ({
            materialId: m.materialId ?? `mat_${randomUUID().slice(0, 8)}`,
            type: m.type,
            contentHash: m.contentHash ?? m.hash ?? null,
            uri: m.uri ?? null,
          })),
          submittedBy,
        },
      },
      expected
    );
    return submissionId;
  }

  // 复核整改材料。职责隔离：复核人不得是提交人，也不得是当初记录问题的检查员。
  // expectedCaseVersion 由调用方在读模型后给出；两个复核人并发提交时：
  //  - 结论一致 → 作为附议保留；
  //  - 结论互斥 → 追加冲突标记，案件进入 conflicted，需裁定，禁止自动恢复。
  reviewRemediation({ caseId, submissionId, result, reviewer, note = "", expectedCaseVersion }) {
    if (!["approved", "rejected"].includes(result)) fail(ErrorCode.INVALID_ARGUMENT, "复核结论须为 approved / rejected");
    let view = this.view();
    let c = view.cases.get(caseId);
    if (!c) fail(ErrorCode.NOT_FOUND, `案件不存在：${caseId}`);
    const sub = c.remediationSubmissions.find((s) => s.submissionId === submissionId);
    if (!sub) fail(ErrorCode.NOT_FOUND, `整改提交不存在：${submissionId}`);

    if (reviewer.id === sub.submittedBy.id || reviewer.role === sub.submittedBy.role) {
      fail(ErrorCode.INVALID_STATE, "整改材料必须由另一角色复核，提交人不得复核自己的材料");
    }
    for (const issue of c.issues.values()) {
      if (issue.recordedBy?.id && reviewer.id === issue.recordedBy.id) {
        fail(ErrorCode.INVALID_STATE, "复核人不得是记录该问题的检查员");
      }
    }
    if (sub.reviews.some((r) => r.reviewer?.id === reviewer.id)) {
      fail(ErrorCode.CONFLICT, `复核人 ${reviewer.id} 已对该提交作出结论`);
    }

    const concurrent =
      expectedCaseVersion !== undefined && expectedCaseVersion !== this.store.versionOf(caseId);
    const priorOutcome = sub.outcome;
    const priorReviewer = sub.reviews.find((r) => r.result !== result)?.reviewer?.id;

    this.store.append({
      event_type: EventType.REMEDIATION_REVIEWED,
      aggregate_type: Aggregate.CASE,
      aggregate_id: caseId,
      occurred_at: this.clock.now(),
      summary: `整改复核：${submissionId} ${result === "approved" ? "通过" : "不通过"}（${reviewer.role}/${reviewer.id}）`,
      payload: {
        caseId,
        submissionId,
        result,
        reviewer,
        note,
        concurrentWith: concurrent ? priorReviewer ?? null : null,
      },
    });

    if (priorOutcome && priorOutcome !== result) {
      const conflictId = newId("rc");
      this.store.append({
        event_type: EventType.REMEDIATION_REVIEW_CONFLICTED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `并发复核结论冲突：${submissionId}（${priorOutcome} vs ${result}），需裁定`,
        payload: {
          caseId,
          conflictId,
          submissionId,
          outcomes: [
            { result: priorOutcome, by: priorReviewer },
            { result, by: reviewer.id },
          ],
          status: "open",
        },
      });
      fail(ErrorCode.REVIEW_CONFLICT, `整改复核冲突：${priorOutcome} 与 ${result}`, {
        conflictId,
        submissionId,
      });
    }
    return { concurrent: Boolean(concurrent), endorsed: Boolean(priorOutcome) };
  }

  // 复查（现场）：记录复查证据与是否通过。
  recordReinspection({ caseId, issueIds, passed, evidence = [], inspector }) {
    const expected = this.store.versionOf(caseId);
    const c = this.view().cases.get(caseId);
    if (!c) fail(ErrorCode.NOT_FOUND, `案件不存在：${caseId}`);
    const ids = issueIds ?? [...c.issues.keys()];
    for (const id of ids) if (!c.issues.has(id)) fail(ErrorCode.NOT_FOUND, `问题不存在：${id}`);
    this.store.append(
      {
        event_type: EventType.REINSPECTION_RECORDED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `复查记录：${ids.length} 项，${passed ? "通过" : "未通过"}`,
        payload: {
          caseId,
          issueIds: ids,
          passed,
          inspector,
          evidence: evidence.map((e) => ({
            evidenceId: e.evidenceId ?? `ev_${randomUUID().slice(0, 8)}`,
            type: e.type,
            contentHash: e.contentHash ?? e.hash ?? null,
            uri: e.uri ?? null,
            capturedAt: e.capturedAt ?? this.clock.now(),
          })),
        },
      },
      expected
    );
  }

  // 恢复决定：仅恢复复查通过的问题所影响的范围；其余停售/暂停保持。
  decideReinstatement({ caseId, scope, decidedBy }) {
    const expected = this.store.versionOf(caseId);
    const view = this.view();
    const c = view.cases.get(caseId);
    if (!c) fail(ErrorCode.NOT_FOUND, `案件不存在：${caseId}`);

    const openConflict = c.reviewConflicts.some((x) => x.status === "open" && x.submissionId);
    if (openConflict) fail(ErrorCode.INVALID_STATE, "存在未裁定的并发复核冲突，不得恢复");

    const passed = new Set([...c.issues.values()].filter((i) => i.status === "passed").map((i) => i.issueId));
    if (!passed.size) fail(ErrorCode.INVALID_STATE, "没有复查通过的问题，无可恢复范围");

    // 只处理“本次新通过”的问题；此前恢复已处理的问题不重复恢复。
    const previouslyReinstated = new Set(c.reinstatements.flatMap((r) => r.passedIssueIds ?? r.issueIds ?? []));
    const newlyPassed = [...passed].filter((id) => !previouslyReinstated.has(id));
    if (!newlyPassed.length) fail(ErrorCode.INVALID_STATE, "这些问题此前已恢复，没有新的复查通过项");

    const requestedScope = scope ?? { stores: [c.storeId], categories: [] };
    // 本次新通过问题覆盖的范围（受影响范围）
    const passedScope = newlyPassed
      .map((id) => c.issues.get(id).scope)
      .reduce((acc, sc) => mergeScope(acc, sc), { stores: [], categories: [] });
    const liftable = intersectScope(passedScope, requestedScope);
    if (isEmptyScope(liftable)) fail(ErrorCode.INVALID_STATE, "请求恢复的范围均未通过复查");

    const reinstatementId = newId("rein");
    this.store.append(
      {
        event_type: EventType.REINSTATEMENT_DECIDED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `复查通过，按范围恢复：门店 ${liftable.stores.join("、")} / 品类 ${liftable.categories.join("、") || "（无品类限制）"}`,
        payload: {
          caseId,
          reinstatementId,
          scope: liftable,
          passedIssueIds: newlyPassed,
          decidedBy,
        },
      },
      expected
    );

    // 在各许可上仅解除本案限制中与已通过范围相交的部分；未通过问题的限制保留。
    // 每条限制独立解除，避免一个限制的联合范围误解除另一个限制。
    const liftedLicenses = [];
    for (const lic of view.licenses.values()) {
      const mine = lic.restrictions.filter((r) => r.caseId === caseId);
      if (!mine.length) continue;
      let touched = false;
      let accLift = { stores: [], categories: [] };
      for (const r of mine) {
        // 只解除该限制中属于已通过问题的部分
        const restrictionPassedScope = r.issueIds
          .filter((id) => passed.has(id))
          .reduce((acc, id) => mergeScope(acc, c.issues.get(id)?.scope ?? { stores: [], categories: [] }), { stores: [], categories: [] });
        const piece = intersectScope(intersectScope(r.scope, restrictionPassedScope), requestedScope);
        if (isEmptyScope(piece)) continue;
        touched = true;
        accLift = mergeScope(accLift, piece);
        const licVersion = this.store.versionOf(lic.licenseId);
        this.store.append(
          {
            event_type: EventType.LICENSE_SCOPE_RESUMED,
            aggregate_type: Aggregate.LICENSE,
            aggregate_id: lic.licenseId,
            occurred_at: this.clock.now(),
            summary: `复查通过，解除部分限制（案件 ${caseId}，限制 ${r.restrictionId}）`,
            payload: {
              caseId,
              reinstatementId,
              restrictionId: r.restrictionId,
              liftedScope: piece,
            },
          },
          licVersion
        );
      }
      if (touched) liftedLicenses.push({ licenseId: lic.licenseId, liftedScope: accLift });
    }

    this.notifications?.schedule({
      key: `reinstatement_notice:${reinstatementId}`,
      kind: "reinstatement_notice",
      channel: "operator",
      target: { storeId: c.storeId },
      scheduledFor: this.clock.now(),
      payload: { caseId, reinstatementId, scope: liftable },
    });

    // 案件全部问题均已复查通过 → 闭环，取消该案未决的到期提醒/逾期升级。
    const allPassed = [...c.issues.values()].every((i) => i.status === "passed");
    if (allPassed) this.notifications?.cancelPendingForCase(caseId);

    return { reinstatementId, liftedScope: liftable, liftedLicenses, caseClosed: allPassed };
  }

  // 申诉撤销/冲突裁定后显式结案
  adjudicateReviewConflict({ caseId, conflictId, winningResult, decidedBy }) {
    const expected = this.store.versionOf(caseId);
    const c = this.view().cases.get(caseId);
    const conflict = c?.reviewConflicts.find((x) => x.conflictId === conflictId && x.status === "open");
    if (!conflict) fail(ErrorCode.NOT_FOUND, `未决复核冲突不存在：${conflictId}`);
    // 以“冲突已裁定”形式收口：在冲突事件上补后继记录（事件不可原地改写）。
    this.store.append(
      {
        event_type: EventType.REMEDIATION_REVIEW_CONFLICTED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `复核冲突裁定：${conflictId} → ${winningResult}`,
        payload: { caseId, conflictId, status: "resolved", winningResult, decidedBy },
      },
      expected
    );
  }

  closeCase(caseId, { reason, closedBy }) {
    const expected = this.store.versionOf(caseId);
    if (expected === 0) fail(ErrorCode.NOT_FOUND, `案件不存在：${caseId}`);
    this.store.append(
      {
        event_type: EventType.CASE_CLOSED,
        aggregate_type: Aggregate.CASE,
        aggregate_id: caseId,
        occurred_at: this.clock.now(),
        summary: `结案：${reason ?? ""}`,
        payload: { closedBy },
      },
      expected
    );
  }
}

function unionScope(c, ids) {
  return ids.reduce(
    (acc, id) => mergeScope(acc, c.issues.get(id)?.scope ?? { stores: [], categories: [] }),
    { stores: [], categories: [] }
  );
}

function enforcementSummary(action, scope, ids) {
  const where = scope.stores.join("、");
  const what = scope.categories.join("、") || "全部适用品类";
  switch (action) {
    case Action.RECTIFY_WITH_DEADLINE:
      return `限期整改：${where} / ${what}（${ids.length} 项问题）`;
    case Action.PARTIAL_SUSPENSION:
      return `局部停售：${where} / ${what}`;
    case Action.LICENSE_PAUSE:
      return `暂停许可：${where}`;
    default:
      return `处置：${action}`;
  }
}
