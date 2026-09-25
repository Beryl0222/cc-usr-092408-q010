import { Aggregate, LicenseStatus, isWithinScope } from "../domain/constants.js";
import { EventType } from "../domain/event-types.js";
import { ErrorCode, fail } from "../domain/errors.js";
import { Projection } from "../domain/projection.js";
import { newId } from "./profiles.js";

// 授权链服务：品牌授权 → 经营主体 → 门店/品类，逐层转授。
// 不变量：任何子许可的适用范围（门店、品类）与标准版本都不得超出上级许可，
// 且必须取得规定的批准后才生效。主体变更关闭旧许可但历史责任不转移。
export class LicenseService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
  }

  view() {
    return Projection.fromEvents(this.store.all());
  }

  // 授予许可。parentLicenseId 为空表示品牌办公室直接授权（根许可）。
  grantLicense(input) {
    const {
      licenseId = newId("lic"),
      brandId,
      operatorId,
      scope,
      parentLicenseId = null,
      standardVersionIds = [],
      requiredApprovals = ["brand_office"],
      grantedBy,
      eventId,
    } = input;
    if (this.store.versionOf(licenseId) > 0) fail(ErrorCode.ALREADY_EXISTS, `许可已存在：${licenseId}`);
    const view = this.view();

    if (!view.operators.has(operatorId)) fail(ErrorCode.NOT_FOUND, `经营主体未建档：${operatorId}`);
    if (!view.brands.has(brandId)) fail(ErrorCode.NOT_FOUND, `品牌未建档：${brandId}`);
    if ((scope?.stores?.length ?? 0) === 0 && (scope?.categories?.length ?? 0) === 0) {
      fail(ErrorCode.INVALID_ARGUMENT, "许可适用范围（门店或品类）不能为空");
    }
    for (const s of scope?.stores ?? []) {
      const st = view.stores.get(s);
      if (!st) fail(ErrorCode.NOT_FOUND, `门店未建档：${s}`);
      if (st.brandId !== brandId) fail(ErrorCode.INVALID_ARGUMENT, `门店 ${s} 不属于品牌 ${brandId}`);
    }
    for (const c of scope?.categories ?? []) {
      const cat = view.categories.get(c);
      if (!cat) fail(ErrorCode.NOT_FOUND, `品类未建档：${c}`);
      if (cat.brandId !== brandId) fail(ErrorCode.INVALID_ARGUMENT, `品类 ${c} 不属于品牌 ${brandId}`);
    }
    for (const stdId of standardVersionIds) {
      if (!view.standards.has(stdId)) fail(ErrorCode.NOT_FOUND, `标准版本未建档：${stdId}`);
    }

    let parent = null;
    if (parentLicenseId) {
      parent = view.licenses.get(parentLicenseId);
      if (!parent) fail(ErrorCode.NOT_FOUND, `上级许可不存在：${parentLicenseId}`);
      if (parent.status !== LicenseStatus.ACTIVE) {
        fail(ErrorCode.INVALID_STATE, `上级许可 ${parentLicenseId} 当前状态为 ${parent.status}，不得转授`);
      }
      // 逐级向上穿透校验：子范围必须落在链上每一级范围内。
      const chain = [];
      for (let n = parent; n; n = n.parentLicenseId ? view.licenses.get(n.parentLicenseId) : null) {
        chain.push(n.licenseId);
      }
      let node = parent;
      while (node) {
        if (!isWithinScope(scope, node.scope)) {
          // 越权转授：先落事件留痕（发现即记录），再拒绝本次授予。
          this.store.append({
            event_type: EventType.UNAUTHORIZED_OPERATION_DETECTED,
            aggregate_type: Aggregate.LICENSE,
            aggregate_id: licenseId,
            occurred_at: this.clock.now(),
            summary: `拟转授范围超出上级许可 ${node.licenseId}，已拒绝`,
            payload: {
              brandId,
              attemptedScope: scope,
              ancestorLicenseId: node.licenseId,
              chain,
              operatorId,
              violation: "scope_exceeded",
            },
          });
          fail(ErrorCode.SCOPE_EXCEEDED, `转授权范围超出上级许可 ${node.licenseId}`, {
            ancestor_license_id: node.licenseId,
            chain,
          });
        }
        const stdSet = new Set(node.standardVersionIds);
        const badStd = standardVersionIds.find((s) => !stdSet.has(s));
        if (badStd) {
          fail(ErrorCode.SCOPE_EXCEEDED, `标准版本 ${badStd} 不在上级许可 ${node.licenseId} 适用范围内`, {
            ancestor_license_id: node.licenseId,
            standard_version_id: badStd,
          });
        }
        node = node.parentLicenseId ? view.licenses.get(node.parentLicenseId) : null;
      }
    } else {
      // 根许可：品类/门店必须归属该品牌（上面已校验）。
    }

    const approvals = parentLicenseId
      ? [...new Set([...requiredApprovals, parent.holderOperatorId === operatorId ? "brand_office" : "upstream_holder"])]
      : [...requiredApprovals];

    this.store.append({
      event_id: eventId,
      event_type: EventType.LICENSE_GRANTED,
      aggregate_type: Aggregate.LICENSE,
      aggregate_id: licenseId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: parentLicenseId ? `转授许可：${operatorId}（上级 ${parentLicenseId}）` : `品牌直接授权：${operatorId}`,
      payload: {
        brandId,
        operatorId,
        scope,
        parentLicenseId,
        standardVersionIds,
        requiredApprovals: approvals,
        grantedBy,
      },
    });
    return licenseId;
  }

  // 批准/驳回。许可在全部规定角色批准前保持 pending_approval，不产生授权效力。
  decideApproval(licenseId, { role, decision, reviewer, note = "" }) {
    const expected = this.store.versionOf(licenseId);
    if (expected === 0) fail(ErrorCode.NOT_FOUND, `许可不存在：${licenseId}`);
    const view = this.view();
    const lic = view.licenses.get(licenseId);
    if (![LicenseStatus.PENDING_APPROVAL].includes(lic.status)) {
      fail(ErrorCode.INVALID_STATE, `许可 ${licenseId} 状态 ${lic.status}，不可再审批`);
    }
    if (!lic.requiredApprovals.includes(role)) {
      fail(ErrorCode.INVALID_ARGUMENT, `角色 ${role} 不是该许可规定的批准方：${lic.requiredApprovals.join(", ")}`);
    }
    if (lic.approvals.some((a) => a.role === role)) {
      fail(ErrorCode.CONFLICT, `角色 ${role} 已对许可 ${licenseId} 作出过批准决定`);
    }
    this.store.append(
      {
        event_type: EventType.LICENSE_APPROVAL_DECIDED,
        aggregate_type: Aggregate.LICENSE,
        aggregate_id: licenseId,
        occurred_at: this.clock.now(),
        summary: `许可 ${decision === "approved" ? "批准" : "驳回"}：${role}`,
        payload: { role, decision, reviewer, note },
      },
      expected
    );
  }

  // 经营主体变更（投诉倒查发现实际经营者已换人）。
  // 旧许可关闭，历史问题责任仍归原主体；新主体须另行申请并获批，不得承继。
  reportOperatorChange(input) {
    const {
      storeId,
      previousOperatorId,
      actualOperatorId = null,
      actualOperatorName,
      discoveredVia = "complaint_trace",
      newLicenseId = null,
    } = input;
    const view = this.view();
    const store = view.stores.get(storeId);
    if (!store) fail(ErrorCode.NOT_FOUND, `门店未建档：${storeId}`);

    const closed = [];
    for (const lic of view.licenses.values()) {
      const coversStore = lic.scope.stores.includes(storeId);
      if (!coversStore) continue;
      if (lic.holderOperatorId !== previousOperatorId) continue;
      if ([LicenseStatus.ACTIVE, LicenseStatus.PAUSED, LicenseStatus.PENDING_APPROVAL].includes(lic.status)) {
        const expected = this.store.versionOf(lic.licenseId);
        this.store.append(
          {
            event_type: EventType.LICENSE_CLOSED_BY_CHANGE,
            aggregate_type: Aggregate.LICENSE,
            aggregate_id: lic.licenseId,
            occurred_at: this.clock.now(),
            summary: `经营主体变更，许可关闭（责任留存）：${previousOperatorId} → ${actualOperatorName ?? "未知实际经营者"}`,
            payload: {
              storeId,
              previousOperatorId,
              actualOperatorId,
              actualOperatorName,
              discoveredVia,
              newLicenseId,
              responsibilityRetained: true,
              retainedFor: ["历史巡检问题", "历史处罚", "历史申诉"],
            },
          },
          expected
        );
        closed.push(lic.licenseId);
      }
    }

    // 新主体若没有覆盖该门店的有效许可，即构成“无授权实际经营”，须在视图中显式标出。
    const hasValid = actualOperatorId
      ? [...view.licenses.values()].some(
          (l) =>
            l.status === LicenseStatus.ACTIVE &&
            l.holderOperatorId === actualOperatorId &&
            l.scope.stores.includes(storeId)
        ) || newLicenseId !== null
      : false;
    if (!hasValid) {
      this.store.append({
        event_type: EventType.UNAUTHORIZED_OPERATION_DETECTED,
        aggregate_type: Aggregate.STORE,
        aggregate_id: storeId,
        occurred_at: this.clock.now(),
        summary: `门店 ${storeId} 实际经营者 ${actualOperatorName ?? "不明"} 与品牌许可主体不一致，穿透追查中`,
        payload: {
          storeId,
          brandId: store.brandId,
          previousOperatorId,
          actualOperatorId,
          actualOperatorName,
          discoveredVia,
          violation: "actual_operator_unlicensed",
          closedLicenses: closed,
        },
      });
    }
    return { closedLicenses: closed };
  }

  revokeLicense(licenseId, { reason, actor }) {
    const expected = this.store.versionOf(licenseId);
    if (expected === 0) fail(ErrorCode.NOT_FOUND, `许可不存在：${licenseId}`);
    this.store.append(
      {
        event_type: EventType.LICENSE_REVOKED,
        aggregate_type: Aggregate.LICENSE,
        aggregate_id: licenseId,
        occurred_at: this.clock.now(),
        summary: `许可吊销：${reason}`,
        payload: { reason, revokedBy: actor },
      },
      expected
    );
  }

  // 授权链穿透：从某许可向上回溯到品牌根许可。
  chainOf(licenseId) {
    const view = this.view();
    const chain = [];
    let node = view.licenses.get(licenseId);
    const guard = new Set();
    while (node) {
      if (guard.has(node.licenseId)) break;
      guard.add(node.licenseId);
      chain.push(node);
      node = node.parentLicenseId ? view.licenses.get(node.parentLicenseId) : null;
    }
    return chain;
  }

  // 门店 → 当前/历史覆盖该门店的全部许可（用于穿透到实际档口）。
  licensesCoveringStore(storeId) {
    return [...this.view().licenses.values()].filter((l) => l.scope.stores.includes(storeId));
  }
}
