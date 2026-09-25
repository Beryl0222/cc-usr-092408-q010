import { fail } from "./errors.js";
import { canDelegate, cells, covers, scopeKey, scopeOfCells, subtractCells } from "./scope.js";
import { requireRole } from "./registry.js";

// 授权链：
//   根授权（品牌办公室 -> 经营主体）
//     └─ 转授权（上级持牌主体 -> 下级主体）：不得超出上级范围，且必须经品牌办批准。
//
// 每个许可是独立聚合（licenseId）；批准流程是另一聚合（requestId）。
// 暂停/恢复都「按范围」执行：同一门店的合规品类不会被单个档口的问题连带停售。

export function createAuthorizationService(store, registry) {
  function appendTo(type, aggregateType, id, payload, actor, expectedVersion, occurredAt) {
    return store.append({
      eventType: type,
      aggregateType,
      aggregateId: id,
      payload,
      actor: actor?.staffId ?? null,
      expectedVersion,
      occurredAt,
    });
  }

  // 品牌办公室签发根授权。
  function grantRootLicense(input, actor) {
    requireRole(actor, "brand_admin");
    const a = registry.resolveActor(actor);
    const { licenseId, brandId, holderSubjectId, scope, standardVersionId, grantedAt } = input;
    if (store.history(licenseId).length) fail("ALREADY_EXISTS", `许可已存在：${licenseId}`);
    if (!registry.brand(brandId)) fail("UNKNOWN_BRAND", `品牌未建档：${brandId}`);
    if (!registry.subject(holderSubjectId)) fail("UNKNOWN_SUBJECT", `经营主体未建档：${holderSubjectId}`);
    const std = registry.standard(standardVersionId);
    if (!std) fail("UNKNOWN_STANDARD", `标准版本未建档：${standardVersionId}`);
    if (std.status !== "active") fail("STANDARD_INACTIVE", `标准版本已停用：${standardVersionId}`);
    registry.assertScope(scope);
    return appendTo(
      "LICENSE_GRANTED",
      "license",
      licenseId,
      { licenseId, brandId, holderSubjectId, parentLicenseId: null, scope, standardVersionId, grantedAt, depth: 0 },
      a
    );
  }

  // 第一步：上级持牌主体提出转授权申请。
  function requestSublicense(input, actor) {
    const { requestId, parentLicenseId, toSubjectId, scope, standardVersionId, requestedAt } = input;
    if (store.history(requestId).length) fail("ALREADY_EXISTS", `转授权申请已存在：${requestId}`);
    const parent = mustLicense(parentLicenseId);
    if (parent.status === "revoked") fail("PARENT_REVOKED", `上级许可已吊销，不得转授：${parentLicenseId}`);
    if (!registry.subject(toSubjectId)) fail("UNKNOWN_SUBJECT", `经营主体未建档：${toSubjectId}`);
    const std = registry.standard(standardVersionId);
    if (!std) fail("UNKNOWN_STANDARD", `标准版本未建档：${standardVersionId}`);
    if (std.status !== "active") fail("STANDARD_INACTIVE", `标准版本已停用：${standardVersionId}`);
    registry.assertScope(scope);

    // 不得超出上级「授予范围」，且范围内格点当前未被暂停/吊销。
    if (!canDelegate(parent, scope)) {
      fail("SCOPE_EXCEEDED", "转授权范围超出上级许可的有效范围，或上级该范围已被暂停/吊销", {
        detail: { parentLicenseId, parentScope: parent.scope, parentEffective: parent.effectiveScope, requestedScope: scope },
      });
    }
    return appendTo(
      "SUBLICENSE_REQUESTED",
      "sublicense_request",
      requestId,
      {
        requestId,
        parentLicenseId,
        brandId: parent.brandId,
        fromSubjectId: parent.holderSubjectId,
        toSubjectId,
        scope,
        standardVersionId,
        requestedAt,
        requestedBy: actor?.staffId ?? null,
        status: "pending",
      },
      actor
    );
  }

  // 第二步：品牌办批准后才真正生成下级许可；批准可被乐观锁保护。
  function approveSublicense(input, actor) {
    requireRole(actor, "brand_admin");
    const a = registry.resolveActor(actor);
    const { requestId, licenseId, approvedAt, expectedVersion } = input;
    const request = foldRequest(store.history(requestId));
    if (!request) fail("NOT_FOUND", `转授权申请不存在：${requestId}`);
    if (request.status !== "pending") fail("REQUEST_NOT_PENDING", `申请状态为 ${request.status}，无法批准`);
    if (store.history(licenseId).length) fail("ALREADY_EXISTS", `许可已存在：${licenseId}`);

    // 批准瞬间再次校验：防止申请待批期间上级范围被暂停/吊销。
    const parent = mustLicense(request.parentLicenseId);
    if (parent.status === "revoked") fail("PARENT_REVOKED", `上级许可已吊销，批准无效：${request.parentLicenseId}`);
    if (!canDelegate(parent, request.scope)) {
      fail("SCOPE_EXCEEDED", "批准时复核发现转授权范围已超出上级有效范围或被暂停", {
        detail: { parentLicenseId: parent.licenseId, parentScope: parent.scope, requestedScope: request.scope },
      });
    }

    appendTo(
      "SUBLICENSE_APPROVED",
      "sublicense_request",
      requestId,
      { requestId, licenseId, approvedAt, approvedBy: a.staffId, status: "approved" },
      a,
      expectedVersion
    );
    return appendTo(
      "LICENSE_GRANTED",
      "license",
      licenseId,
      {
        licenseId,
        brandId: request.brandId,
        holderSubjectId: request.toSubjectId,
        parentLicenseId: request.parentLicenseId,
        scope: request.scope,
        standardVersionId: request.standardVersionId,
        grantedAt: approvedAt,
        depth: parent.depth + 1,
        approvedRequestId: requestId,
      },
      a
    );
  }

  function rejectSublicense({ requestId, reason, rejectedAt }, actor) {
    requireRole(actor, "brand_admin");
    const a = registry.resolveActor(actor);
    const request = foldRequest(store.history(requestId));
    if (!request) fail("NOT_FOUND", `转授权申请不存在：${requestId}`);
    if (request.status !== "pending") fail("REQUEST_NOT_PENDING", `申请状态为 ${request.status}，无法驳回`);
    return appendTo(
      "SUBLICENSE_REJECTED",
      "sublicense_request",
      requestId,
      { requestId, reason, rejectedAt, rejectedBy: a.staffId, status: "rejected" },
      a
    );
  }

  // 按范围暂停（局部停售 / 暂停许可的共用底座）。
  function suspendScope(input, actor) {
    const { licenseId, scope, caseId, reason, suspendedAt, suspensionId } = input;
    const license = mustLicense(licenseId);
    if (license.status === "revoked") fail("LICENSE_REVOKED", `许可已吊销：${licenseId}`);
    if (!covers(license.scope, scope)) fail("SCOPE_EXCEEDED", "暂停范围不能超出许可授予范围");
    const id = suspensionId ?? `sus_${licenseId}_${license.suspensions.filter((s) => !s.resumed).length + 1}`;
    if (license.suspensions.some((s) => s.id === id)) fail("ALREADY_EXISTS", `暂停记录已存在：${id}`);
    return appendTo(
      "LICENSE_SUSPENDED",
      "license",
      licenseId,
      { suspensionId: id, scope, caseId: caseId ?? null, reason, suspendedAt, suspendedBy: actor?.staffId ?? null },
      actor
    );
  }

  // 复查通过时仅恢复受影响范围：在本案造成的暂停块上做格点切片，
  // 恢复集合不得超出各块剩余暂停格点；其他案件与同店合规品类不受影响。
  function resumeFromCase(input, actor) {
    const { licenseId, caseId, restoreScope, resumedAt, reviewId } = input;
    const license = mustLicense(licenseId);
    const ownBlocks = license.suspensions.filter((s) => s.caseId === caseId && !s.fullyResumed);
    if (ownBlocks.length === 0) fail("NOT_FOUND", `案件 ${caseId} 在许可 ${licenseId} 上没有待恢复的暂停范围`);

    const restoreCells = cells(restoreScope);
    const restoredBlocks = [];
    for (const block of ownBlocks) {
      const restoredSet = new Set();
      for (const key of restoreCells) if (block.remainingCells.has(key)) restoredSet.add(key);
      if (restoredSet.size === 0) continue;
      if (!covers(block.scope, scopeOfCells(restoredSet))) fail("SCOPE_EXCEEDED", "恢复范围超出原暂停范围");
      restoredBlocks.push({ suspensionId: block.id, restoredScope: scopeOfCells(restoredSet) });
    }
    if (restoredBlocks.length === 0) fail("EMPTY_RESTORE_SCOPE", "恢复范围与本案暂停范围无交集");

    return appendTo(
      "LICENSE_RESUMED",
      "license",
      licenseId,
      {
        caseId,
        restoreScope,
        blocks: restoredBlocks,
        reviewId: reviewId ?? null,
        resumedAt,
        resumedBy: actor?.staffId ?? null,
      },
      actor
    );
  }

  // 整条许可终局吊销（慎用：会影响该许可全部范围；局部问题应优先 suspendScope）。
  function revokeLicense({ licenseId, caseId, reason, revokedAt }, actor) {
    requireRole(actor, "brand_admin");
    const a = registry.resolveActor(actor);
    const license = mustLicense(licenseId);
    if (license.status === "revoked") fail("LICENSE_REVOKED", `许可已吊销：${licenseId}`);
    return appendTo(
      "LICENSE_REVOKED",
      "license",
      licenseId,
      { caseId: caseId ?? null, reason, revokedAt, revokedBy: a.staffId },
      a
    );
  }

  function mustLicense(licenseId) {
    const license = foldLicense(store.history(licenseId));
    if (!license) fail("NOT_FOUND", `许可不存在：${licenseId}`);
    return license;
  }

  return {
    grantRootLicense,
    requestSublicense,
    approveSublicense,
    rejectSublicense,
    suspendScope,
    resumeFromCase,
    revokeLicense,
    mustLicense,
  };
}

// ---- 折叠 ----

export function foldLicense(events) {
  let base = null;
  const suspensions = [];
  let revoked = null;
  for (const e of events) {
    if (e.event_type === "LICENSE_GRANTED") {
      base = e.payload;
    } else if (e.event_type === "LICENSE_SUSPENDED") {
      suspensions.push({
        id: e.payload.suspensionId,
        scope: e.payload.scope,
        remainingCells: cells(e.payload.scope),
        caseId: e.payload.caseId,
        reason: e.payload.reason,
        suspendedAt: e.payload.suspendedAt,
        suspendedBy: e.payload.suspendedBy,
        fullyResumed: false,
        resumes: [],
      });
    } else if (e.event_type === "LICENSE_RESUMED") {
      for (const block of e.payload.blocks) {
        const target = suspensions.find((s) => s.id === block.suspensionId);
        if (!target) continue;
        target.remainingCells = subtractCells(target.remainingCells, cells(block.restoredScope));
        target.fullyResumed = target.remainingCells.size === 0;
        target.resumes.push({
          restoredScope: block.restoredScope,
          caseId: e.payload.caseId,
          reviewId: e.payload.reviewId,
          resumedAt: e.payload.resumedAt,
          resumedBy: e.payload.resumedBy,
        });
      }
    } else if (e.event_type === "LICENSE_REVOKED") {
      revoked = e.payload;
    }
  }
  if (!base) return null;

  // 精确到格点：授予格点、当前暂停格点、仍有效格点。
  const grantedCells = cells(base.scope);
  const suspendedCells = new Set();
  for (const block of suspensions) {
    if (block.fullyResumed) continue;
    for (const key of block.remainingCells) {
      if (grantedCells.has(key)) suspendedCells.add(key);
    }
  }
  const effectiveCells = subtractCells(grantedCells, suspendedCells);
  // effectiveScope 是有效格点的外包矩形，仅用于展示；精确判定请用 effectiveCells。
  const effectiveScope = scopeOfCells(effectiveCells);
  const suspendedScope = scopeOfCells(suspendedCells);
  const activeBlockCount = suspensions.filter((s) => !s.fullyResumed).length;

  return {
    ...base,
    status: revoked ? "revoked" : effectiveCells.size === 0 ? "suspended" : activeBlockCount ? "partially_suspended" : "active",
    suspensions,
    revoked,
    grantedCells,
    suspendedCells,
    effectiveCells,
    suspendedScope,
    effectiveScope,
    scopeKey: scopeKey(base.scope),
  };
}

export function foldRequest(events) {
  let request = null;
  for (const e of events) {
    if (e.event_type === "SUBLICENSE_REQUESTED") request = { ...e.payload };
    else if (e.event_type === "SUBLICENSE_APPROVED") Object.assign(request, e.payload);
    else if (e.event_type === "SUBLICENSE_REJECTED") Object.assign(request, e.payload);
  }
  return request;
}

// 汇总全部许可，供穿透视图与冲突检测使用。
export function buildLicenseIndex(store) {
  const licenses = new Map();
  const requests = new Map();
  for (const e of store.all()) {
    if (e.aggregate_type === "license") {
      if (!licenses.has(e.aggregate_id) || e.event_type !== "LICENSE_GRANTED") {
        licenses.set(e.aggregate_id, foldLicense(store.history(e.aggregate_id)));
      }
    } else if (e.aggregate_type === "sublicense_request") {
      requests.set(e.aggregate_id, foldRequest(store.history(e.aggregate_id)));
    }
  }
  return {
    licenses: () => [...licenses.values()].filter(Boolean),
    license: (id) => licenses.get(id) ?? null,
    requests: () => [...requests.values()].filter(Boolean),
    // 持牌主体 -> 其名下全部许可
    byHolder: (subjectId) => [...licenses.values()].filter((l) => l && l.holderSubjectId === subjectId),
    // 授权链：自任一许可向上回溯到根。
    chainOf(licenseId) {
      const chain = [];
      let current = licenses.get(licenseId);
      const guard = new Set();
      while (current) {
        if (guard.has(current.licenseId)) break;
        guard.add(current.licenseId);
        chain.push(current);
        current = current.parentLicenseId ? licenses.get(current.parentLicenseId) : null;
      }
      return chain;
    },
  };
}
