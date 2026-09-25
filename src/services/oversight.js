import { LicenseStatus, isWithinScope } from "../domain/constants.js";
import { Projection } from "../domain/projection.js";

// 监管统一视图。
// 无论监管人员从品牌、门店还是处罚（处置决定）进入，都看到同一份完整事实：
// 授权链、适用标准版本、证据、申诉、整改复核与恢复决定，
// 并显式标出越权转授、实际经营者无授权、并发复核冲突等风险发现。
export class OversightService {
  constructor(store) {
    this.store = store;
  }

  #snapshot() {
    return Projection.fromEvents(this.store.all());
  }

  byBrand(brandId) {
    const view = this.#snapshot();
    if (!view.brands.has(brandId)) return notFound(`品牌不存在：${brandId}`);
    const storeIds = [...view.stores.values()].filter((s) => s.brandId === brandId).map((s) => s.storeId);
    return this.#assemble(view, { entrypoint: { type: "brand", id: brandId }, brandId, storeIds });
  }

  byStore(storeId) {
    const view = this.#snapshot();
    const store = view.stores.get(storeId);
    if (!store) return notFound(`门店不存在：${storeId}`);
    return this.#assemble(view, { entrypoint: { type: "store", id: storeId }, brandId: store.brandId, storeIds: [storeId] });
  }

  byEnforcement(enforcementId) {
    const view = this.#snapshot();
    for (const c of view.cases.values()) {
      const enf = c.enforcement.find((e) => e.enforcementId === enforcementId);
      if (enf) {
        return this.#assemble(view, {
          entrypoint: { type: "enforcement", id: enforcementId, caseId: c.caseId },
          brandId: c.brandId,
          storeIds: [c.storeId],
          focusEnforcementId: enforcementId,
        });
      }
    }
    return notFound(`处罚决定不存在：${enforcementId}`);
  }

  #assemble(view, ctx) {
    const { brandId, storeIds } = ctx;
    const storeSet = new Set(storeIds);

    // ---- 授权链：覆盖这些门店的许可及其向上回溯 ----
    const covering = [...view.licenses.values()].filter(
      (l) => l.scope.stores.some((s) => storeSet.has(s))
    );
    const coveringIds = new Set(covering.map((l) => l.licenseId));
    const chainNodes = new Map(covering.map((l) => [l.licenseId, l]));
    for (const lic of covering) {
      let node = lic;
      while (node.parentLicenseId) {
        const parent = view.licenses.get(node.parentLicenseId);
        if (!parent) break;
        chainNodes.set(parent.licenseId, parent);
        node = parent;
      }
    }
    const chainForest = buildForest([...chainNodes.values()], view);

    // 链上许可适用的标准版本
    const standardIds = new Set();
    for (const lic of chainNodes.values()) for (const s of lic.standardVersionIds) standardIds.add(s);

    // ---- 案件（含问题、证据、处置、申诉、复核、复查、恢复） ----
    const cases = [...view.cases.values()]
      .filter((c) => c.brandId === brandId && storeSet.has(c.storeId))
      .map((c) => serializeCase(c, view));
    for (const c of cases) for (const i of c.issues) standardIds.add(i.standardVersionId);

    // ---- 适用标准版本详情 ----
    const standards = [...standardIds]
      .map((id) => view.standards.get(id))
      .filter(Boolean)
      .map((s) => ({
        standardId: s.standardId,
        versionNo: s.versionNo,
        title: s.title,
        status: s.status,
        effectiveFrom: s.effectiveFrom,
        clauseCount: s.clauses?.length ?? 0,
      }))
      .sort((a, b) => (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? ""));

    // ---- 离线回执差异调查（全局可见，供监管核查） ----
    const receiptInvestigations = [...view.receipts.values()].flatMap((r) =>
      r.investigations.map((inv) => ({
        receiptNo: r.receiptNo,
        investigationId: inv.investigationId,
        status: inv.status,
        reason: inv.reason,
        openedAt: inv.openedAt,
        resolution: inv.resolution,
        resolvedAt: inv.resolvedAt ?? null,
      }))
    );

    // ---- 主体档案（轻量） ----
    const operatorIds = new Set();
    for (const lic of chainNodes.values()) operatorIds.add(lic.holderOperatorId);
    for (const s of view.stores.values()) if (storeSet.has(s.storeId)) {
      for (const u of s.unauthorizedActuals ?? []) {
        if (u.previousOperatorId) operatorIds.add(u.previousOperatorId);
        if (u.actualOperatorId) operatorIds.add(u.actualOperatorId);
      }
    }
    const operators = [...operatorIds]
      .map((id) => view.operators.get(id))
      .filter(Boolean)
      .map((o) => ({ operatorId: o.operatorId, name: o.name, creditCode: o.creditCode }));

    const findings = deriveFindings(view, { brandId, storeIds, chainNodes, coveringIds, cases });

    return {
      entrypoint: ctx.entrypoint,
      brand: view.brands.get(brandId)
        ? { brandId, name: view.brands.get(brandId).name, officeName: view.brands.get(brandId).officeName }
        : null,
      stores: storeIds.map((id) => {
        const s = view.stores.get(id);
        return s
          ? {
              storeId: s.storeId,
              name: s.name,
              address: s.address,
              actualOperatorChanges: s.unauthorizedActuals ?? [],
              currentLicensedOperators: currentLicensedOperators(view, id),
            }
          : { storeId: id, missing: true };
      }),
      operators,
      authorizationChain: {
        forest: chainForest,
        coveringLicenses: covering.map((l) => l.licenseId),
      },
      applicableStandards: standards,
      cases,
      receiptInvestigations,
      findings,
    };
  }
}

function currentLicensedOperators(view, storeId) {
  return [...new Set(
    [...view.licenses.values()]
      .filter((l) => l.status === LicenseStatus.ACTIVE && l.scope.stores.includes(storeId))
      .map((l) => l.holderOperatorId)
  )];
}

function buildForest(nodes, view) {
  const byId = new Map(nodes.map((n) => [n.licenseId, n]));
  const childrenOf = new Map();
  const roots = [];
  for (const n of nodes) {
    const parentId = n.parentLicenseId;
    if (parentId && byId.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(n.licenseId);
    } else {
      roots.push(n.licenseId);
    }
  }
  const render = (licenseId) => {
    const l = byId.get(licenseId);
    return {
      licenseId: l.licenseId,
      holderOperatorId: l.holderOperatorId,
      parentLicenseId: l.parentLicenseId,
      status: l.status,
      scope: l.scope,
      standardVersionIds: l.standardVersionIds,
      approvals: l.approvals,
      restrictions: l.restrictions,
      closure: l.closure,
      grantedAt: l.grantedAt,
      children: (childrenOf.get(licenseId) ?? []).map(render),
    };
  };
  return roots.map(render);
}

function serializeCase(c, view) {
  return {
    caseId: c.caseId,
    storeId: c.storeId,
    source: c.source,
    sourceRef: c.sourceRef,
    status: c.status,
    openedAt: c.openedAt,
    issues: [...c.issues.values()].map((i) => ({
      issueId: i.issueId,
      standardVersionId: i.standardVersionId,
      standard: standardBrief(view, i.standardVersionId),
      severity: i.severity,
      foodSafetyCritical: i.foodSafetyCritical,
      scope: i.scope,
      operatorIdAtCheck: i.operatorIdAtCheck,
      suggestedRisk: i.suggestedRisk,
      confirmedRisk: i.confirmedRisk,
      riskOverridden: Boolean(i.suggestedRisk && i.confirmedRisk && i.suggestedRisk !== i.confirmedRisk),
      status: i.status,
      recordedAt: i.recordedAt,
      evidence: i.evidence,
    })),
    enforcement: c.enforcement.map((e) => ({
      enforcementId: e.enforcementId,
      action: e.action,
      scope: e.scope,
      issueIds: e.issueIds,
      deadline: e.deadline,
      foodSafetyMeasure: e.foodSafetyMeasure,
      decidedBy: e.decidedBy,
      decidedAt: e.decidedAt,
      frozenByAppeal: e.frozenByAppeal,
      appeal: e.appeal,
    })),
    remediationSubmissions: c.remediationSubmissions.map((s) => ({
      submissionId: s.submissionId,
      issueIds: s.issueIds,
      materials: s.materials,
      submittedBy: s.submittedBy,
      submittedAt: s.submittedAt,
      reviews: s.reviews,
      outcome: s.outcome,
    })),
    reviewConflicts: c.reviewConflicts,
    reinspections: c.reinspections,
    reinstatements: c.reinstatements,
    escalations: c.escalations,
  };
}

function standardBrief(view, standardVersionId) {
  const s = view.standards.get(standardVersionId);
  return s ? { versionNo: s.versionNo, title: s.title, status: s.status, effectiveFrom: s.effectiveFrom } : null;
}

// 派生发现：越权转授（含历史尝试）、链上当前范围不一致、无授权实际经营、并发复核冲突等。
function deriveFindings(view, { brandId, storeIds, chainNodes, coveringIds, cases }) {
  const findings = [];
  const push = (severity, code, message, ref) => findings.push({ severity, code, message, ...ref });

  // 1) 事件流已记录的越权/无授权标记
  const scopeStoreSet = new Set(storeIds);
  for (const f of view.flags) {
    if (f.brandId && f.brandId !== brandId) continue;
    const touchesScope = f.storeId
      ? scopeStoreSet.has(f.storeId)
      : (f.attemptedScope?.stores ?? []).some((s) => scopeStoreSet.has(s));
    // 越权转授：即使拟转门店不在入口内，只要被越过的上级许可覆盖入口门店，也应可见
    const viaAncestor =
      f.violation === "scope_exceeded" &&
      (f.chain ?? [f.ancestorLicenseId]).some((lid) =>
        view.licenses.get(lid)?.scope.stores.some((s) => scopeStoreSet.has(s))
      );
    if (!touchesScope && !viaAncestor) continue;
    if (f.violation === "scope_exceeded") {
      push("high", "unauthorized_sublicense", `转授权超出上级许可 ${f.ancestorLicenseId} 范围，授予被拒绝并留痕`, {
        licenseId: f.refAggregateId,
        chain: f.chain,
        attemptedScope: f.attemptedScope,
        at: f.at,
      });
    } else if (f.violation === "actual_operator_unlicensed") {
      push("high", "actual_operator_unlicensed", `门店 ${f.storeId} 实际经营者（${f.actualOperatorName ?? "不明"}）无有效品牌许可`, {
        storeId: f.storeId,
        previousOperatorId: f.previousOperatorId,
        actualOperatorId: f.actualOperatorId,
        closedLicenses: f.closedLicenses,
        at: f.at,
      });
    }
  }

  // 2) 当前授权链上的静态一致性复核（防止绕过服务直接入库等情形）
  for (const lic of chainNodes.values()) {
    if (!lic.parentLicenseId) continue;
    const parent = chainNodes.get(lic.parentLicenseId) ?? view.licenses.get(lic.parentLicenseId);
    if (!parent) {
      push("high", "broken_chain", `许可 ${lic.licenseId} 引用的上级许可 ${lic.parentLicenseId} 缺失`, {
        licenseId: lic.licenseId,
      });
      continue;
    }
    if (!isWithinScope(lic.scope, parent.scope)) {
      push("high", "scope_violation_active", `许可 ${lic.licenseId} 的范围超出上级许可 ${parent.licenseId}`, {
        licenseId: lic.licenseId,
        parentLicenseId: parent.licenseId,
        childScope: lic.scope,
        parentScope: parent.scope,
      });
    }
    const parentStd = new Set(parent.standardVersionIds);
    const badStd = lic.standardVersionIds.find((s) => !parentStd.has(s));
    if (badStd) {
      push("medium", "standard_out_of_scope", `许可 ${lic.licenseId} 适用标准 ${badStd} 不在上级许可范围内`, {
        licenseId: lic.licenseId,
        standardVersionId: badStd,
      });
    }
    // 未批先生效（防御性检测：状态机异常）
    if (lic.status === LicenseStatus.ACTIVE) {
      const missing = lic.requiredApprovals.filter(
        (r) => !lic.approvals.some((a) => a.role === r && a.decision === "approved")
      );
      if (missing.length) {
        push("high", "license_active_without_approval", `许可 ${lic.licenseId} 缺少批准角色：${missing.join("、")}`, {
          licenseId: lic.licenseId,
          missingApprovals: missing,
        });
      }
    }
  }

  // 3) 门店现状：登记的实际经营者变更后，是否仍无有效许可承接
  for (const storeId of storeIds) {
    const store = view.stores.get(storeId);
    const latest = [...(store?.unauthorizedActuals ?? [])].at(-1);
    if (latest) {
      const licensed = currentLicensedOperators(view, storeId);
      const stillUnlicensed = latest.actualOperatorId
        ? !licensed.includes(latest.actualOperatorId)
        : licensed.length === 0;
      if (stillUnlicensed) {
        push("high", "store_operating_without_valid_license", `门店 ${storeId} 招牌仍在使用但无承接的有效许可`, {
          storeId,
          discoveredVia: latest.discoveredVia,
        });
      }
    }
  }

  // 4) 并发复核冲突
  for (const c of cases) {
    for (const conflict of c.reviewConflicts ?? []) {
      push(
        conflict.status === "open" ? "high" : "low",
        conflict.status === "open" ? "concurrent_review_conflict_open" : "concurrent_review_conflict_resolved",
        conflict.status === "open"
          ? `案件 ${c.caseId} 存在未裁定的并发复核冲突（${conflict.submissionId}），已阻断自动恢复`
          : `案件 ${c.caseId} 并发复核冲突已裁定：${conflict.winningResult}`,
        { caseId: c.caseId, conflictId: conflict.conflictId, submissionId: conflict.submissionId }
      );
    }
    // 5) 申诉中：提示冻结边界
    for (const e of c.enforcement ?? []) {
      if (e.frozenByAppeal && e.appeal?.status === "pending") {
        push("medium", "appeal_pending", `处罚 ${e.enforcementId} 争议处罚已冻结；食品安全措施仍保持`, {
          caseId: c.caseId,
          enforcementId: e.enforcementId,
        });
      }
    }
    // 6) 自动分级未确认即处置不应发生（防御）/ 建议与确认不一致仅提示
    for (const i of c.issues ?? []) {
      if (i.riskOverridden) {
        push("info", "risk_overridden_by_inspector", `问题 ${i.issueId} 检查员改判风险（建议 ${i.suggestedRisk} → 确认 ${i.confirmedRisk}）`, {
          caseId: c.caseId,
          issueId: i.issueId,
        });
      }
    }
  }

  return findings;
}

function notFound(message) {
  const e = new Error(message);
  e.code = "NOT_FOUND";
  throw e;
}
