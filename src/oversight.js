import { buildRegistryIndex } from "./registry.js";
import { buildLicenseIndex, foldLicense } from "./authorization.js";
import { foldCase, foldAppeal } from "./compliance.js";
import { cells, covers, scopeOfCells } from "./scope.js";

// 监管穿透视图：从品牌、门店或处罚（案件）任一入口进入，
// 都能看到完整授权链、适用标准、证据、申诉及恢复决定，
// 并识别越权转授、实际经营者与许可错位、并发复核造成的冲突。

export function createOversight(store) {
  function indexes() {
    return { registry: buildRegistryIndex(store), licenses: buildLicenseIndex(store) };
  }

  function collectCases() {
    const cases = new Map();
    for (const e of store.all()) {
      if (e.aggregate_type === "case" && !cases.has(e.aggregate_id)) {
        cases.set(e.aggregate_id, foldCase(store.history(e.aggregate_id)));
      }
    }
    return [...cases.values()];
  }

  function collectAppeals() {
    const appeals = new Map();
    for (const e of store.all()) {
      if (e.aggregate_type === "appeal" && !appeals.has(e.aggregate_id)) {
        appeals.set(e.aggregate_id, foldAppeal(store.history(e.aggregate_id)));
      }
    }
    return [...appeals.values()];
  }

  function licenseChainView(licenses, licenseId) {
    return licenses.chainOf(licenseId).map((l) => ({
      licenseId: l.licenseId,
      brandId: l.brandId,
      holderSubjectId: l.holderSubjectId,
      parentLicenseId: l.parentLicenseId,
      depth: l.depth,
      grantedScope: l.scope,
      effectiveScope: l.effectiveScope,
      status: l.status,
      standardVersionId: l.standardVersionId,
      suspensions: l.suspensions.map((s) => ({
        id: s.id,
        scope: s.scope,
        remainingScope: scopeOfCells(s.remainingCells),
        caseId: s.caseId,
        fullyResumed: s.fullyResumed,
        resumes: s.resumes,
      })),
      revoked: l.revoked,
    }));
  }

  function caseView(reg, licenses, c) {
    const appeals = collectAppeals().filter((a) => a.caseId === c.caseId);
    const chain = c.licenseId ? licenseChainView(licenses, c.licenseId) : [];
    const standard = c.inspection?.standardSnapshot
      ? {
          standardVersionId: c.inspection.standardSnapshot.standardVersionId,
          versionNo: c.inspection.standardSnapshot.versionNo,
          title: c.inspection.standardSnapshot.title,
          contentFingerprint: c.inspection.standardSnapshot.contentFingerprint,
          itemCount: c.inspection.standardSnapshot.items.length,
        }
      : null;
    return {
      caseId: c.caseId,
      storeId: c.storeId,
      stallId: c.stallId,
      status: c.status,
      complaints: c.complaints.map((x) => ({ complaintId: x.complaintId, content: x.content, receivedAt: x.receivedAt, fingerprint: x.contentFingerprint })),
      inspection: c.inspection
        ? {
            inspectorStaffId: c.inspection.inspectorStaffId,
            inspectedAt: c.inspection.inspectedAt,
            standard,
            findings: c.inspection.findings,
            evidence: c.inspection.evidence,
            suggestedRisk: c.inspection.suggestedRisk,
          }
        : null,
      riskConfirmed: c.riskConfirmed,
      disposition: c.disposition,
      remediation: c.remediation.map((r) => ({
        submittedAt: r.submittedAt,
        submittedBy: r.submittedBy,
        materials: r.materials,
      })),
      review: c.review,
      appeals,
      activePenaltyHold: c.activePenaltyHold,
      heldPenalties: c.heldPenalties ?? [],
      escalations: c.escalations ?? [],
      closedAt: c.closedAt ?? null,
      licenseChain: chain,
    };
  }

  // 门店入口：穿透到每个档口的实际经营者及其名下许可。
  function fromStore(storeId) {
    const { registry: reg, licenses } = indexes();
    const store = reg.store(storeId);
    if (!store) return null;
    const allCases = collectCases().filter((c) => c.storeId === storeId);
    const stalls = [...store.stalls.values()].map((stall) => {
      const operatorLicenses = licenses.byHolder(stall.operatorSubjectId).filter(
        (l) => l.scope.stores.includes(storeId) || l.scope.stores.includes("*")
      );
      return {
        stallId: stall.stallId,
        operatorSubjectId: stall.operatorSubjectId,
        since: stall.since,
        until: stall.until,
        licenses: operatorLicenses.map((l) => l.licenseId),
      };
    });
    const chainLicenseIds = [...new Set(stalls.flatMap((s) => s.licenses))];
    const chainLicenseObjects = chainLicenseIds.map((id) => licenses.license(id)).filter(Boolean);
    return {
      entry: "store",
      store: {
        storeId: store.storeId,
        name: store.name,
        address: store.address,
        brandId: store.brandId,
      },
      operatorTimeline: store.operatorTimeline,
      stalls,
      authorizationChains: chainLicenseIds.map((id) => licenseChainView(licenses, id)),
      applicableStandards: standardBindings(reg, chainLicenseObjects, allCases),
      cases: allCases.map((c) => caseView(reg, licenses, c)),
      conflicts: detectConflicts({ reg, licenses }).filter((x) => x.storeId === storeId || x.relatedStoreIds?.includes(storeId)),
    };
  }

  // 品牌入口：品牌下全部门店与许可。
  function fromBrand(brandId) {
    const { registry: reg, licenses } = indexes();
    const brand = reg.brand(brandId);
    if (!brand) return null;
    const brandStores = reg.stores().filter((s) => s.brandId === brandId);
    const brandLicenses = licenses.licenses().filter((l) => l.brandId === brandId);
    const storeIds = new Set([
      ...brandStores.map((s) => s.storeId),
      ...brandLicenses.flatMap((l) => l.scope.stores.filter((x) => x !== "*")),
    ]);
    const allCases = collectCases().filter((c) => storeIds.has(c.storeId));
    return {
      entry: "brand",
      brand,
      stores: brandStores.map((s) => ({ storeId: s.storeId, name: s.name, stalls: [...s.stalls.values()] })),
      authorizationChains: [...new Set(brandLicenses.map((l) => l.licenseId))].map((id) => licenseChainView(licenses, id)),
      applicableStandards: standardBindings(reg, brandLicenses, allCases),
      cases: allCases.map((c) => caseView(reg, licenses, c)),
      conflicts: detectConflicts({ reg, licenses }).filter(
        (x) => x.brandId === brandId || x.relatedStoreIds?.some((id) => storeIds.has(id))
      ),
    };
  }

  // 处罚入口：从案件/处罚反查整条链。
  function fromCase(caseId) {
    const { registry: reg, licenses } = indexes();
    const c = collectCases().find((x) => x.caseId === caseId);
    if (!c) return null;
    return {
      entry: "penalty",
      case: caseView(reg, licenses, c),
      conflicts: detectConflicts({ reg, licenses }).filter((x) => x.caseId === caseId),
    };
  }

  function standardBindings(reg, licenseList, cases) {
    const ids = new Set();
    for (const license of licenseList) ids.add(license.standardVersionId);
    for (const c of cases) if (c.inspection) ids.add(c.inspection.standardSnapshot.standardVersionId);
    return [...ids]
      .map((id) => {
        const s = reg.standard(id);
        return s ? { standardVersionId: id, title: s.title, versionNo: s.versionNo, status: s.status, contentFingerprint: s.contentFingerprint } : null;
      })
      .filter(Boolean);
  }

  // ---- 冲突识别 ----
  function detectConflicts(arg) {
    const idx = arg ?? (() => {
      const built = indexes();
      return { reg: built.registry, licenses: built.licenses };
    })();
    const { reg, licenses } = idx;
    const conflicts = [];

    // 1) 越权转授：下级授予范围超出上级「授予范围」（硬越权）。
    //    以及上级相关范围已被暂停/吊销、下级却仍在该范围内有效（有效性缺口）。
    for (const child of licenses.licenses()) {
      if (!child.parentLicenseId) continue;
      const parent = licenses.license(child.parentLicenseId);
      if (!parent) continue;
      if (!covers(parent.scope, child.scope)) {
        conflicts.push({
          type: "over_grant",
          severity: "high",
          brandId: child.brandId,
          childLicenseId: child.licenseId,
          parentLicenseId: parent.licenseId,
          relatedStoreIds: child.scope.stores,
          message: `转授权 ${child.licenseId} 的范围超出上级许可 ${parent.licenseId}`,
        });
      } else {
        // 上级矩形虽覆盖下级，但上级某些格点已被暂停/吊销，下级在这些格点上失去有效来源。
        const blockedCells = [];
        for (const key of cells(child.scope)) {
          if (parent.suspendedCells?.has(key) || parent.status === "revoked") blockedCells.push(key);
        }
        if (blockedCells.length) {
          conflicts.push({
            type: "ancestor_scope_gap",
            severity: "medium",
            brandId: child.brandId,
            childLicenseId: child.licenseId,
            parentLicenseId: parent.licenseId,
            relatedStoreIds: child.scope.stores,
            blockedScope: scopeOfCells(new Set(blockedCells)),
            message: `上级许可相关格点已被暂停/吊销，下级 ${child.licenseId} 的部分授权失去有效来源`,
          });
        }
      }
    }

    // 2) 实际经营者与许可错位：招牌仍挂品牌、档口已换主体，但许可停留在原主体。
    for (const store of reg.stores()) {
      for (const stall of store.stalls.values()) {
        const current = licenses.byHolder(stall.operatorSubjectId).some(
          (l) => (l.scope.stores.includes(store.storeId) || l.scope.stores.includes("*")) && l.status !== "revoked"
        );
        const timeline = store.operatorTimeline.filter((t) => t.stallId === stall.stallId);
        const previousHadLicense = timeline.some((t) =>
          t.fromSubjectId
            ? licenses.byHolder(t.fromSubjectId).some((l) => l.scope.stores.includes(store.storeId) || l.scope.stores.includes("*"))
            : false
        );
        if (!current && previousHadLicense) {
          conflicts.push({
            type: "operator_license_stale",
            severity: "high",
            storeId: store.storeId,
            brandId: store.brandId,
            stallId: stall.stallId,
            operatorSubjectId: stall.operatorSubjectId,
            message: `门店 ${store.storeId} 档口 ${stall.stallId} 实际经营者已变更为 ${stall.operatorSubjectId}，但品牌许可仍停留在原主体名下`,
          });
        }
      }
    }

    // 3) 并发复核冲突：同一案件出现多份针对同一批整改材料指纹、但复核人不同的复核结论。
    //    正常情况下乐观锁只允许一份落库；一旦检出说明存在绕过锁的并发写入。
    for (const c of collectCases()) {
      const reviewEvents = store
        .history(c.caseId)
        .filter((e) => e.event_type === "REVIEW_DECIDED");
      const groups = new Map();
      for (const e of reviewEvents) {
        const key = [...(e.payload.materialFingerprints ?? [])].sort().join("|");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
      for (const [key, group] of groups) {
        const reviewers = new Set(group.map((e) => e.payload.reviewerStaffId));
        if (reviewers.size > 1) {
          conflicts.push({
            type: "concurrent_review_conflict",
            severity: "high",
            caseId: c.caseId,
            storeId: c.storeId,
            reviewIds: group.map((e) => e.payload.reviewId),
            reviewers: [...reviewers],
            materialFingerprintKey: key,
            message: `案件 ${c.caseId} 的同一批整改材料出现 ${reviewers.size} 名复核人的并发结论，需裁定以何者为准`,
          });
        }
      }
      // 申诉期间食品安全措施被错误解除（正常流程不会发生；作为数据一致性巡检）。
      const pendingAppeal = collectAppeals().some((a) => a.caseId === c.caseId && a.status === "pending");
      if (pendingAppeal && c.licenseId && c.disposition?.safetyMeasure && c.status !== "closed") {
        const license = foldLicense(store.history(c.licenseId));
        const stillSuspended = license.suspensions.some((s) => s.caseId === c.caseId && !s.fullyResumed);
        if (!stillSuspended) {
          conflicts.push({
            type: "safety_measure_lifted",
            severity: "high",
            caseId: c.caseId,
            storeId: c.storeId,
            message: `案件 ${c.caseId} 的食品安全措施在申诉/复查关闭前被解除，与「申诉不解除食品安全措施」相违`,
          });
        }
      }
    }

    return conflicts;
  }

  return { fromBrand, fromStore, fromCase, detectConflicts, collectCases, collectAppeals };
}
