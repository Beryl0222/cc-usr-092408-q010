import { fail } from "./errors.js";
import { contentFingerprint } from "./fingerprint.js";
import { covers, cells as cellsOf, scopeOfCells } from "./scope.js";
import { requireRole, operatorAt, pastOperators } from "./registry.js";
import { foldLicense } from "./authorization.js";

// 合规案件聚合（caseId）：投诉 -> 巡检 -> 风险确认 -> 处置 -> 整改 -> 复核 -> 恢复/关闭。
// 申诉为独立聚合（appealId）。
//
// 关键约束：
//  - 巡检问题绑定「检查当时」的标准版本（含内容指纹与条目快照）与证据指纹；
//  - 自动风险分级仅供参考，必须由检查员确认后才能处置；
//  - 申诉只冻结争议处罚，食品安全措施（停售/暂停）不解除；
//  - 整改材料由另一角色复核（复核人不得是巡检人或处置决定人）；
//  - 复查通过时仅恢复受影响范围。

export function createComplianceService(store, registry, auth) {
  function append(type, aggregateType, id, payload, actor, expectedVersion, occurredAt) {
    return store.append({
      eventType: type,
      aggregateType,
      aggregateId: id,
      payload,
      actor: actor?.staffId ?? actor?.subjectId ?? null,
      expectedVersion,
      occurredAt,
    });
  }

  function mustCase(caseId) {
    const c = foldCase(store.history(caseId));
    if (!c) fail("NOT_FOUND", `案件不存在：${caseId}`);
    return c;
  }

  function recordComplaint(input, actor) {
    const { caseId, storeId, stallId = null, brandId = null, content, channel = "walk_in", receivedAt } = input;
    if (store.history(caseId).length) fail("ALREADY_EXISTS", `案件已存在：${caseId}`);
    if (!registry.store(storeId)) fail("UNKNOWN_STORE", `门店未建档：${storeId}`);
    return append(
      "COMPLAINT_FILED",
      "case",
      caseId,
      {
        complaintId: input.complaintId ?? `cmp_${caseId}`,
        storeId,
        stallId,
        brandId,
        channel,
        content,
        contentFingerprint: contentFingerprint(content),
        receivedAt,
      },
      actor
    );
  }

  // 巡检：固化标准快照与证据指纹。snapshotOf 由调用方提供当时适用的标准内容。
  function recordInspection(input, actor) {
    requireRole(actor, "inspector");
    const a = registry.resolveActor(actor);
    const c = mustCase(input.caseId);
    const { inspectedAt, standardVersionId, findings = [], evidence = [], advisory } = input;
    const standard = registry.standard(standardVersionId);
    if (!standard) fail("UNKNOWN_STANDARD", `标准版本未建档：${standardVersionId}`);

    const stampedEvidence = evidence.map((ev) => ({
      evidenceId: ev.evidenceId,
      type: ev.type ?? "photo",
      collectedAt: ev.collectedAt ?? inspectedAt,
      collectedOffline: ev.collectedOffline ?? false,
      contentFingerprint: ev.contentFingerprint ?? contentFingerprint(ev.content ?? ev),
      uri: ev.uri ?? null,
    }));
    const stampedFindings = findings.map((f) => ({
      item: f.item,
      detail: f.detail ?? "",
      severity: f.severity ?? "minor",
      evidenceIds: f.evidenceIds ?? [],
    }));
    // 责任主体按「检查当时」档口实际经营者锁定；历任主体一并留档，主体变化不切断历史责任。
    const storeRecord = registry.store(c.storeId);
    const responsibleSubjectId = c.stallId ? operatorAt(storeRecord, c.stallId, inspectedAt) : null;
    const historicalSubjectIds = c.stallId ? pastOperators(storeRecord, c.stallId) : [];
    // 检查当时的标准快照：版本号 + 内容指纹 + 条目，事后标准换版不改变本巡检依据。
    const standardSnapshot = {
      standardVersionId,
      title: standard.title,
      versionNo: standard.versionNo,
      contentFingerprint: standard.contentFingerprint,
      items: standard.items,
    };
    return append(
      "INSPECTION_RECORDED",
      "case",
      c.caseId,
      {
        storeId: c.storeId,
        stallId: c.stallId,
        inspectorStaffId: a.staffId,
        inspectedAt,
        responsibleSubjectId,
        historicalSubjectIds,
        standardSnapshot,
        findings: stampedFindings,
        evidence: stampedEvidence,
        suggestedRisk: advisory, // { suggestedLevel, ruleHits, advisory: true }
      },
      a
    );
  }

  // 确认风险：检查员可采纳或调整建议级别；未确认不得处置。
  function confirmRisk(input, actor) {
    requireRole(actor, "inspector");
    const a = registry.resolveActor(actor);
    const c = mustCase(input.caseId);
    if (!c.inspection) fail("INSPECTION_REQUIRED", "需先记录巡检才能确认风险");
    if (c.riskConfirmed) fail("ALREADY_CONFIRMED", "风险已确认；如需变更请发起复议");
    if (!["high", "medium", "low"].includes(input.confirmedLevel)) {
      fail("INVALID_LEVEL", "风险级别须为 high/medium/low");
    }
    return append(
      "RISK_CONFIRMED",
      "case",
      c.caseId,
      {
        confirmedLevel: input.confirmedLevel,
        suggestedLevel: c.inspection.suggestedRisk?.suggestedLevel ?? null,
        acceptedSuggestion: input.confirmedLevel === c.inspection.suggestedRisk?.suggestedLevel,
        note: input.note ?? null,
        confirmedBy: a.staffId,
        confirmedAt: input.confirmedAt,
      },
      a
    );
  }

  // 处置三选一：限期整改 / 局部停售 / 暂停许可。
  function decideDisposition(input, actor) {
    requireRole(actor, "inspector");
    const a = registry.resolveActor(actor);
    const c = mustCase(input.caseId);
    if (!c.riskConfirmed) fail("RISK_NOT_CONFIRMED", "风险级别未经检查员确认，不得处置");
    if (c.disposition) fail("DISPOSITION_EXISTS", "处置已作出；改变处置需走复议/申诉流程");

    const { kind, decidedAt } = input;
    if (!["rectify", "partial_stop_sale", "suspend_license"].includes(kind)) {
      fail("INVALID_KIND", "处置类型须为 rectify/partial_stop_sale/suspend_license");
    }

    const licenseId = input.licenseId ?? c.licenseId ?? null;
    let license = licenseId ? foldLicense(store.history(licenseId)) : null;
    if (kind !== "rectify" && !license) fail("LICENSE_REQUIRED", `${kind} 处置需要定位到具体许可`);

    let scope = input.scope ?? null;
    let deadline = input.deadline ?? null;
    let suspensionEvent = null;

    if (kind === "rectify") {
      if (!deadline) fail("DEADLINE_REQUIRED", "限期整改必须给出截止时间");
    } else {
      // 停售/暂停都是食品安全措施：落在具体许可的具体范围上，不连带同店合规品类。
      scope =
        kind === "suspend_license"
          ? license.scope
          : requireWithinLicense(license, input.scope, c);
      suspensionEvent = auth.suspendScope(
        {
          licenseId: license.licenseId,
          scope,
          caseId: c.caseId,
          reason: input.reason ?? `案件 ${c.caseId} 处置`,
          suspendedAt: decidedAt,
          suspensionId: input.suspensionId,
        },
        a
      );
    }

    const event = append(
      "DISPOSITION_DECIDED",
      "case",
      c.caseId,
      {
        kind,
        licenseId: license?.licenseId ?? null,
        scope,
        deadline,
        reason: input.reason ?? null,
        decidedBy: a.staffId,
        decidedAt,
        suspensionEventId: suspensionEvent?.event_id ?? null,
        safetyMeasure: kind !== "rectify", // 局部停售/暂停许可 = 食品安全措施
        confirmedLevel: c.riskConfirmed.confirmedLevel,
      },
      a
    );
    return event;
  }

  // 申诉：只冻结争议「处罚」，食品安全措施保持有效。
  function fileAppeal(input, actor) {
    const { appealId, caseId, disputedDisposition = null, grounds, filedAt } = input;
    const c = mustCase(caseId);
    if (!c.disposition) fail("NO_DISPOSITION", "案件尚无处置决定，无法申诉");
    if (store.history(appealId).length) fail("ALREADY_EXISTS", `申诉已存在：${appealId}`);
    const target = disputedDisposition ?? c.disposition.kind;
    const disposition = c.disposition;
    // 食品安全措施不可被申诉冻结；只有非安全措施类处罚（如限期整改）可冻结。
    const freezesPenalty = target === "rectify" || !disposition.safetyMeasure;
    const liftsSafetyMeasure = false; // 明确：申诉不解除食品安全措施
    append(
      "APPEAL_FILED",
      "appeal",
      appealId,
      {
        appealId,
        caseId,
        disputedDisposition: target,
        grounds,
        filedAt,
        filedBy: actor?.subjectId ?? actor?.staffId ?? null,
        status: "pending",
        effect: { freezesPenalty, liftsSafetyMeasure, frozenUntil: "appeal_resolved" },
      },
      actor
    );
    // 在案件上留一条冻结记录，便于处罚入口直接看到「争议处罚已冻结、食安措施仍在」。
    if (freezesPenalty) {
      append(
        "PENALTY_HELD_BY_APPEAL",
        "case",
        caseId,
        { appealId, heldDisposition: target, heldAt: filedAt, safetyMeasureUnaffected: true },
        actor
      );
    }
    return store.history(appealId)[0];
  }

  function resolveAppeal(input, actor) {
    requireRole(actor, "supervisor");
    const a = registry.resolveActor(actor);
    const events = store.history(input.appealId);
    const appeal = foldAppeal(events);
    if (!appeal) fail("NOT_FOUND", `申诉不存在：${input.appealId}`);
    if (appeal.status !== "pending") fail("APPEAL_NOT_PENDING", `申诉状态为 ${appeal.status}`);
    if (!["upheld", "rejected"].includes(input.decision)) fail("INVALID_DECISION", "申诉决定须为 upheld/rejected");
    append(
      "APPEAL_RESOLVED",
      "appeal",
      input.appealId,
      {
        appealId: input.appealId,
        decision: input.decision,
        note: input.note ?? null,
        resolvedAt: input.resolvedAt,
        resolvedBy: a.staffId,
        // 无论申诉结果如何，食品安全措施都不自动解除；支持/撤销处罚另行产生处置后继记录。
        safetyMeasureRemains: true,
      },
      a
    );
    // 解除处罚冻结：驳回则恢复执行；成立则撤销争议处罚。食品安全措施始终不动。
    // 若申诉针对的是食品安全措施（本就未冻结），则不产生处罚冻结/解除记录。
    if (appeal.effect?.freezesPenalty) {
      append(
        "PENALTY_HOLD_RELEASED",
        "case",
        appeal.caseId,
        {
          appealId: input.appealId,
          releasedAt: input.resolvedAt,
          outcome: input.decision === "upheld" ? "penalty_vacated" : "penalty_resumed",
          safetyMeasureRemains: true,
        },
        a
      );
    }
    return store.history(input.appealId).find((e) => e.event_type === "APPEAL_RESOLVED");
  }

  // 经营主体提交整改材料（可离线）。
  function submitRemediation(input, actor) {
    const c = mustCase(input.caseId);
    if (!c.disposition) fail("NO_DISPOSITION", "案件尚无处置决定");
    if (c.status === "closed") fail("CASE_CLOSED", "案件已关闭");
    const materials = (input.materials ?? []).map((m) => ({
      materialId: m.materialId,
      type: m.type ?? "document",
      contentFingerprint: m.contentFingerprint ?? contentFingerprint(m.content ?? m),
      submittedAt: m.submittedAt ?? input.submittedAt,
      collectedOffline: m.collectedOffline ?? false,
    }));
    if (materials.length === 0) fail("NO_MATERIALS", "整改材料不能为空");
    return append(
      "REMEDIATION_SUBMITTED",
      "case",
      c.caseId,
      {
        materials,
        submittedAt: input.submittedAt,
        submittedBy: actor?.subjectId ?? actor?.staffId ?? null,
        note: input.note ?? null,
      },
      actor
    );
  }

  // 另一角色复核。并发复核由聚合版本乐观锁拦截：expectedVersion 不匹配抛 VERSION_CONFLICT。
  function reviewRemediation(input, actor) {
    requireRole(actor, "reviewer");
    const a = registry.resolveActor(actor);
    const c = mustCase(input.caseId);
    // 并发闸门前置：在产生任何恢复/关闭副作用之前先校验版本，
    // 两名复核人并发提交时，后者立即收到 VERSION_CONFLICT，不会写出半成品状态。
    if (input.expectedVersion !== undefined) {
      const currentVersion = store.history(c.caseId).length;
      if (input.expectedVersion !== currentVersion) {
        fail("VERSION_CONFLICT", `案件 ${c.caseId} 并发复核冲突：期望版本 ${input.expectedVersion}，实际 ${currentVersion}`, {
          detail: { expectedVersion: input.expectedVersion, currentVersion, caseId: c.caseId },
        });
      }
    }
    if (!c.latestRemediation) fail("REMEDIATION_REQUIRED", "尚未收到整改材料，无法复核");
    if (c.review && c.review.decision === "approved" && c.status === "closed") {
      fail("ALREADY_REVIEWED", "整改已复核通过并关闭");
    }
    // 职责分离：复核人不得是巡检人或处置决定人。
    const inspector = c.inspection?.inspectorStaffId;
    const decider = c.disposition?.decidedBy;
    if (a.staffId === inspector || a.staffId === decider) {
      fail("REVIEWER_CONFLICT", "复核人不得是本案巡检人或处置决定人");
    }
    if (!["approved", "rejected"].includes(input.decision)) fail("INVALID_DECISION", "复核结论须为 approved/rejected");

    let restoreScope = null;
    let resumeEvent = null;
    if (input.decision === "approved") {
      // 复查通过：仅恢复受影响范围。以本案在该许可上造成的「仍暂停」块为上界，
      // 其他案件造成的暂停、以及从未停售的合规品类都不受影响。
      const license = c.disposition.licenseId ? foldLicense(store.history(c.disposition.licenseId)) : null;
      const ownBlocks = license
        ? license.suspensions.filter((s) => s.caseId === c.caseId && !s.fullyResumed)
        : [];
      if (ownBlocks.length) {
        // 本案在该许可上仍暂停的格点并集 = 可恢复上界。
        const ownSuspendedCells = new Set();
        for (const b of ownBlocks) for (const key of b.remainingCells) ownSuspendedCells.add(key);
        const requestedCells = input.restoreScope ? cellsOf(input.restoreScope) : ownSuspendedCells;
        const boundedCells = new Set();
        for (const key of requestedCells) if (ownSuspendedCells.has(key)) boundedCells.add(key);
        if (boundedCells.size === 0) {
          fail("EMPTY_RESTORE_SCOPE", "恢复范围与本案暂停范围无交集");
        }
        restoreScope = scopeOfCells(boundedCells);
        resumeEvent = auth.resumeFromCase(
          {
            licenseId: license.licenseId,
            caseId: c.caseId,
            restoreScope,
            resumedAt: input.reviewedAt,
            reviewId: input.reviewId,
          },
          a
        );
      }
      append(
        "REMEDIATION_CLOSED",
        "case",
        c.caseId,
        { reviewId: input.reviewId, closedAt: input.reviewedAt },
        a
      );
    }
    return append(
      "REVIEW_DECIDED",
      "case",
      c.caseId,
      {
        reviewId: input.reviewId,
        reviewerStaffId: a.staffId,
        decision: input.decision,
        restoreScope,
        note: input.note ?? null,
        reviewedAt: input.reviewedAt,
        resumeEventId: resumeEvent?.event_id ?? null,
        materialFingerprints: c.latestRemediation.materials.map((m) => m.contentFingerprint),
      },
      a
    );
  }

  function requireWithinLicense(license, scope, c) {
    if (!scope) fail("SCOPE_REQUIRED", "局部停售必须指定停售范围");
    const tied = tieScopeToCase(scope, c);
    if (!covers(license.scope, tied)) {
      fail("SCOPE_EXCEEDED", "局部停售范围超出该许可的授予范围", {
        detail: { licenseScope: license.scope, requested: tied },
      });
    }
    return tied;
  }

  // 处置范围若只给了品类/档口，补齐案件门店，保证范围可落在授权链上。
  function tieScopeToCase(scope, c) {
    return {
      stores: scope.stores?.length ? scope.stores : [c.storeId],
      categories: [...scope.categories],
    };
  }

  return {
    recordComplaint,
    recordInspection,
    confirmRisk,
    decideDisposition,
    fileAppeal,
    resolveAppeal,
    submitRemediation,
    reviewRemediation,
    mustCase,
  };
}

// ---- 折叠 ----

export function foldCase(events) {
  const c = {
    caseId: null,
    storeId: null,
    stallId: null,
    complaints: [],
    inspection: null,
    riskConfirmed: null,
    disposition: null,
    remediation: [],
    latestRemediation: null,
    review: null,
    status: "opened",
    licenseId: null,
    suspensionEventIds: [],
  };

  for (const e of events) {
    switch (e.event_type) {
      case "COMPLAINT_FILED":
        c.caseId = e.aggregate_id;
        c.storeId = e.payload.storeId;
        c.stallId = e.payload.stallId;
        c.complaints.push(e.payload);
        break;
      case "INSPECTION_RECORDED":
        c.inspection = e.payload;
        c.status = "inspected";
        break;
      case "RISK_CONFIRMED":
        c.riskConfirmed = e.payload;
        c.status = "risk_confirmed";
        break;
      case "DISPOSITION_DECIDED":
        c.disposition = e.payload;
        c.licenseId = e.payload.licenseId;
        if (e.payload.suspensionEventId) c.suspensionEventIds.push(e.payload.suspensionEventId);
        c.status = e.payload.kind === "rectify" ? "rectifying" : "measure_active";
        break;
      case "REMEDIATION_SUBMITTED":
        c.remediation.push(e.payload);
        c.latestRemediation = e.payload;
        if (c.status !== "measure_active") c.status = "submitted";
        else c.status = "measure_active_remediation_submitted";
        break;
      case "REVIEW_DECIDED":
        c.review = e.payload;
        if (e.payload.decision === "rejected") c.status = "review_rejected";
        break;
      case "REMEDIATION_CLOSED":
        c.closedAt = e.payload.closedAt;
        c.status = "closed";
        break;
      case "ESCALATION_RECORDED":
        c.escalations = c.escalations ?? [];
        c.escalations.push(e.payload);
        break;
      case "PENALTY_HELD_BY_APPEAL":
        c.heldPenalties = c.heldPenalties ?? [];
        c.heldPenalties.push({ ...e.payload, released: null });
        break;
      case "PENALTY_HOLD_RELEASED": {
        c.heldPenalties = c.heldPenalties ?? [];
        const hold = [...c.heldPenalties].reverse().find((h) => h.appealId === e.payload.appealId && !h.released);
        if (hold) hold.released = e.payload;
        break;
      }
    }
  }
  // 当前是否仍有争议处罚处于冻结（食品安全措施从不在冻结之列）。
  c.activePenaltyHold = (c.heldPenalties ?? []).find((h) => !h.released) ?? null;
  return c;
}

export function foldAppeal(events) {
  let appeal = null;
  for (const e of events) {
    if (e.event_type === "APPEAL_FILED") appeal = { ...e.payload };
    else if (e.event_type === "APPEAL_RESOLVED") Object.assign(appeal, e.payload, { status: e.payload.decision === "upheld" ? "upheld" : "rejected" });
  }
  return appeal;
}
