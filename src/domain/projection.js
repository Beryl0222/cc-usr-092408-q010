import { LicenseStatus, ReviewResult } from "./constants.js";
import { EventType } from "./event-types.js";

// 不可变事件流 → 当前读模型。所有查询（授权链、案件、回执、通知补发）都从这里取数。
export class Projection {
  constructor() {
    this.brands = new Map();
    this.operators = new Map();
    this.stores = new Map();
    this.categories = new Map();
    this.standards = new Map();
    this.licenses = new Map();
    this.cases = new Map();
    this.receipts = new Map();
    this.notifications = new Map();
    /** 冲突与越权标记（含派生检测结果） */
    this.flags = [];
  }

  apply(event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case EventType.BRAND_REGISTERED:
        this.brands.set(event.aggregate_id, { brandId: event.aggregate_id, ...p });
        break;
      case EventType.OPERATOR_REGISTERED:
        this.operators.set(event.aggregate_id, { operatorId: event.aggregate_id, ...p });
        break;
      case EventType.STORE_REGISTERED:
        this.stores.set(event.aggregate_id, {
          storeId: event.aggregate_id,
          brandId: p.brandId,
          name: p.name,
          address: p.address,
          ...p,
        });
        break;
      case EventType.CATEGORY_REGISTERED:
        this.categories.set(event.aggregate_id, { categoryId: event.aggregate_id, ...p });
        break;
      case EventType.STANDARD_PUBLISHED:
        this.standards.set(event.aggregate_id, {
          standardId: event.aggregate_id,
          status: "active",
          ...p,
        });
        break;
      case EventType.STANDARD_DEPRECATED: {
        const std = this.standards.get(event.aggregate_id);
        if (std) std.status = "deprecated";
        break;
      }

      // ---- 授权链 ----
      case EventType.LICENSE_GRANTED:
        this.licenses.set(event.aggregate_id, {
          licenseId: event.aggregate_id,
          brandId: p.brandId,
          holderOperatorId: p.operatorId,
          storeId: p.storeId ?? null,
          scope: { stores: [...(p.scope?.stores ?? [])], categories: [...(p.scope?.categories ?? [])] },
          parentLicenseId: p.parentLicenseId ?? null,
          status: LicenseStatus.PENDING_APPROVAL,
          requiredApprovals: [...(p.requiredApprovals ?? [])],
          approvals: [],
          standardVersionIds: [...(p.standardVersionIds ?? [])],
          grantedAt: event.occurred_at,
          grantedBy: p.grantedBy,
          restrictions: [], // 生效中的停售/暂停范围
          closure: null,
        });
        break;
      case EventType.LICENSE_APPROVAL_DECIDED: {
        const lic = this.licenses.get(event.aggregate_id);
        if (!lic) break;
        lic.approvals.push({ ...p, at: event.occurred_at });
        if (p.decision === "rejected") {
          lic.status = LicenseStatus.REJECTED;
        } else if (lic.requiredApprovals.every((r) => lic.approvals.some((a) => a.role === r && a.decision === "approved"))) {
          lic.status = LicenseStatus.ACTIVE;
        }
        break;
      }
      case EventType.LICENSE_CLOSED_BY_CHANGE: {
        const lic = this.licenses.get(event.aggregate_id);
        if (lic) {
          lic.status = "closed_by_change";
          lic.closure = { ...p, at: event.occurred_at, responsibilityRetained: true };
        }
        const store = this.stores.get(p.storeId);
        if (store) {
          store.unauthorizedActuals = store.unauthorizedActuals ?? [];
          store.unauthorizedActuals.push({
            previousOperatorId: p.previousOperatorId,
            actualOperatorName: p.actualOperatorName,
            discoveredVia: p.discoveredVia,
            at: event.occurred_at,
            newLicenseId: p.newLicenseId ?? null,
          });
        }
        break;
      }
      case EventType.LICENSE_SCOPE_SUSPENDED: {
        const lic = this.licenses.get(event.aggregate_id);
        if (lic) {
          lic.restrictions.push({
            restrictionId: p.restrictionId,
            mode: p.mode ?? "partial_suspension", // partial_suspension | license_pause
            scope: { stores: [...(p.scope?.stores ?? [])], categories: [...(p.scope?.categories ?? [])] },
            reason: p.reason,
            caseId: p.caseId,
            enforcementId: p.enforcementId ?? null,
            issueIds: [...(p.issueIds ?? [])],
            foodSafetyMeasure: p.foodSafetyMeasure ?? false,
            since: event.occurred_at,
          });
          // 暂停许可：许可整体进入 paused；局部停售保持 active，仅范围受限。
          if (p.mode === "license_pause" && lic.status === LicenseStatus.ACTIVE) {
            lic.status = LicenseStatus.PAUSED;
          }
        }
        break;
      }
      case EventType.LICENSE_SCOPE_RESUMED: {
        const lic = this.licenses.get(event.aggregate_id);
        if (!lic) break;
        const lifted = {
          stores: new Set(p.liftedScope?.stores ?? p.scope?.stores ?? []),
          categories: new Set(p.liftedScope?.categories ?? p.scope?.categories ?? []),
        };
        const targets = new Set(
          p.restrictionId ? [p.restrictionId] : p.restrictionIds ?? []
        );
        const remaining = [];
        for (const r of lic.restrictions) {
          // 指定了目标限制时，仅处理目标限制；否则按案件范围处理。
          const targeted = targets.size ? targets.has(r.restrictionId) : r.caseId === p.caseId;
          if (!targeted) {
            remaining.push(r);
            continue;
          }
          const kept = {
            stores: r.scope.stores.filter((s) => !lifted.stores.has(s)),
            categories: r.scope.categories.filter((c) => !lifted.categories.has(c)),
          };
          r.lifts = r.lifts ?? [];
          r.lifts.push({
            liftedScope: {
              stores: r.scope.stores.filter((s) => lifted.stores.has(s)),
              categories: r.scope.categories.filter((c) => lifted.categories.has(c)),
            },
            caseId: p.caseId,
            at: event.occurred_at,
          });
          if (kept.stores.length || kept.categories.length) {
            r.scope = kept; // 部分解除：未通过复查的范围继续停售
            remaining.push(r);
          }
          // 整体解除（差集为空）：restriction 消失
        }
        lic.restrictions = remaining;
        // 暂停许可随其暂停类限制全部解除而恢复有效；局部停售限制不改变许可 active 状态。
        if (lic.status === LicenseStatus.PAUSED && !remaining.some((r) => r.mode === "license_pause")) {
          lic.status = LicenseStatus.ACTIVE;
        }
        break;
      }
      case EventType.LICENSE_REVOKED: {
        const lic = this.licenses.get(event.aggregate_id);
        if (lic) {
          lic.status = LicenseStatus.REVOKED;
          lic.closure = { reason: "revoked", ...p, at: event.occurred_at };
        }
        break;
      }
      case EventType.UNAUTHORIZED_OPERATION_DETECTED:
        this.flags.push({
          kind: "unauthorized_operation",
          refAggregateType: event.aggregate_type,
          refAggregateId: event.aggregate_id,
          eventId: event.event_id,
          ...p,
          at: event.occurred_at,
        });
        break;

      // ---- 巡检案件 ----
      case EventType.CASE_OPENED:
        this.cases.set(event.aggregate_id, {
          caseId: event.aggregate_id,
          brandId: p.brandId,
          storeId: p.storeId,
          source: p.source,
          status: "open",
          openedAt: event.occurred_at,
          issues: new Map(),
          enforcement: [],
          appeals: [],
          escalations: [],
          remediationSubmissions: [],
          reviewConflicts: [],
          reinspections: [],
          reinstatements: [],
        });
        break;
      case EventType.ISSUE_RECORDED: {
        const c = this.cases.get(p.caseId);
        if (!c) break;
        c.issues.set(p.issueId, {
          issueId: p.issueId,
          standardVersionId: p.standardVersionId, // 检查当时的标准版本，事后标准换版不改写
          evidence: p.evidence ?? [],
          severity: p.severity,
          foodSafetyCritical: p.foodSafetyCritical ?? false,
          operatorIdAtCheck: p.operatorIdAtCheck, // 责任主体快照
          recordedBy: p.recordedBy ?? null, // 用于复核职责隔离
          scope: { stores: [...(p.scope?.stores ?? [])], categories: [...(p.scope?.categories ?? [])] },
          suggestedRisk: null,
          confirmedRisk: null,
          status: "open",
          recordedAt: event.occurred_at,
        });
        break;
      }
      case EventType.RISK_SUGGESTED: {
        const c = this.cases.get(p.caseId);
        const issue = c?.issues.get(p.issueId);
        if (issue) issue.suggestedRisk = p.risk;
        break;
      }
      case EventType.RISK_CONFIRMED: {
        const c = this.cases.get(p.caseId);
        const issue = c?.issues.get(p.issueId);
        if (issue) {
          issue.confirmedRisk = p.risk;
          issue.status = "rectifying";
        }
        break;
      }
      case EventType.ENFORCEMENT_DECIDED: {
        const c = this.cases.get(p.caseId);
        if (!c) break;
        c.enforcement.push({
          enforcementId: p.enforcementId,
          action: p.action,
          scope: { stores: [...(p.scope?.stores ?? [])], categories: [...(p.scope?.categories ?? [])] },
          issueIds: [...(p.issueIds ?? [])],
          deadline: p.deadline ?? null,
          foodSafetyMeasure: p.foodSafetyMeasure ?? false,
          decidedBy: p.decidedBy,
          decidedAt: event.occurred_at,
          frozenByAppeal: false, // 申诉是否已冻结
          appeal: null,
        });
        c.status = "action_decided";
        for (const id of p.issueIds ?? []) {
          const issue = c.issues.get(id);
          if (issue) issue.status = p.action === "rectify_with_deadline" ? "rectifying" : "suspended_scope";
        }
        break;
      }
      case EventType.APPEAL_FILED: {
        const c = this.cases.get(p.caseId);
        if (!c) break;
        const enf = c.enforcement.find((e) => e.enforcementId === p.enforcementId);
        if (enf) {
          enf.frozenByAppeal = true;
          enf.appeal = {
            enforcementId: p.enforcementId,
            status: "pending",
            reason: p.reason,
            filedBy: p.filedBy,
            filedAt: event.occurred_at,
          };
        }
        c.status = "appealed";
        c.appeals.push(enf?.appeal ?? { enforcementId: p.enforcementId, status: "pending" });
        break;
      }
      case EventType.APPEAL_DECIDED: {
        const c = this.cases.get(p.caseId);
        if (!c) break;
        const enf = c.enforcement.find((e) => e.enforcementId === p.enforcementId);
        if (enf?.appeal) {
          enf.appeal.status = p.decision; // upheld | overturned | adjusted
          enf.appeal.decisionDetail = p.detail;
          enf.appeal.decidedAt = event.occurred_at;
          // 申诉已有结论：冻结解除（食品安全措施由许可限制独立承载，不依赖此标志）
          enf.frozenByAppeal = false;
        }
        break;
      }
      case EventType.REMEDIATION_SUBMITTED: {
        const c = this.cases.get(p.caseId);
        if (!c) break;
        c.remediationSubmissions.push({
          submissionId: p.submissionId,
          issueIds: [...(p.issueIds ?? [])],
          materials: p.materials ?? [],
          submittedBy: p.submittedBy,
          submittedAt: event.occurred_at,
          reviews: [],
          outcome: null,
        });
        c.status = "remediation_submitted";
        for (const id of p.issueIds ?? []) {
          const issue = c.issues.get(id);
          if (issue) issue.status = "remediation_submitted";
        }
        break;
      }
      case EventType.REMEDIATION_REVIEWED: {
        const c = this.cases.get(p.caseId);
        const sub = c?.remediationSubmissions.find((s) => s.submissionId === p.submissionId);
        if (!sub) break;
        sub.reviews.push({ result: p.result, reviewer: p.reviewer, note: p.note, at: event.occurred_at });
        if (p.result === ReviewResult.APPROVED || p.result === ReviewResult.REJECTED) {
          if (sub.outcome && sub.outcome !== p.result) {
            // 两个不同复核人给出互斥结论：记录冲突，不静默覆盖。
            // （服务层会先抛出 REVIEW_CONFLICT，此分支兜底重放历史。）
          }
          sub.outcome = p.result;
        }
        break;
      }
      case EventType.REMEDIATION_REVIEW_CONFLICTED: {
        const c = this.cases.get(p.caseId ?? event.aggregate_id);
        if (!c) break;
        // 裁定记录更新原冲突；首次出现则新建。事件本身仍只追加，不改写历史。
        const existing = p.conflictId
          ? c.reviewConflicts.find((x) => x.conflictId === p.conflictId && x.status === "open")
          : null;
        if (existing) {
          existing.status = p.status;
          existing.winningResult = p.winningResult;
          existing.resolvedAt = event.occurred_at;
          existing.decidedBy = p.decidedBy;
        } else {
          c.reviewConflicts.push({ ...p, at: event.occurred_at });
        }
        break;
      }
      case EventType.REINSPECTION_RECORDED: {
        const c = this.cases.get(p.caseId);
        if (!c) break;
        c.reinspections.push({
          issueIds: [...(p.issueIds ?? [])],
          passed: p.passed,
          inspector: p.inspector,
          evidence: p.evidence ?? [],
          at: event.occurred_at,
        });
        c.status = "reinspecting";
        for (const id of p.issueIds ?? []) {
          const issue = c.issues.get(id);
          if (issue) issue.status = p.passed ? "passed" : "failed";
        }
        break;
      }
      case EventType.REINSTATEMENT_DECIDED: {
        const c = this.cases.get(p.caseId);
        if (!c) break;
        c.reinstatements.push({
          scope: { stores: [...(p.scope?.stores ?? [])], categories: [...(p.scope?.categories ?? [])] },
          liftedScope: {
            stores: [...(p.liftedScope?.stores ?? [])],
            categories: [...(p.liftedScope?.categories ?? [])],
          },
          passedIssueIds: [...(p.passedIssueIds ?? p.issueIds ?? [])],
          reinstatementId: p.reinstatementId ?? null,
          decidedBy: p.decidedBy,
          at: event.occurred_at,
        });
        for (const id of p.issueIds ?? []) {
          const issue = c.issues.get(id);
          if (issue) issue.status = "passed";
        }
        break;
      }
      case EventType.ESCALATION_RAISED: {
        const c = this.cases.get(p.caseId);
        if (c) c.escalations.push({ ...p, at: event.occurred_at });
        break;
      }
      case EventType.CASE_CLOSED: {
        const c = this.cases.get(event.aggregate_id);
        if (c) c.status = "closed";
        break;
      }

      // ---- 离线回执 ----
      case EventType.RECEIPT_REGISTERED:
        this.receipts.set(p.receiptNo, {
          receiptNo: p.receiptNo,
          canonicalFingerprint: p.fingerprint,
          firstEventId: event.event_id,
          firstUploadedAt: event.occurred_at,
          uploads: [{ eventId: event.event_id, fingerprint: p.fingerprint, deviceId: p.deviceId, at: event.occurred_at }],
          mergedCount: 0,
          investigations: [],
        });
        break;
      case EventType.RECEIPT_MERGED: {
        const r = this.receipts.get(p.receiptNo);
        if (r) {
          r.uploads.push({ eventId: event.event_id, fingerprint: p.fingerprint, deviceId: p.deviceId, at: event.occurred_at });
          r.mergedCount += 1;
        }
        break;
      }
      case EventType.RECEIPT_CONTENT_INVESTIGATION_OPENED: {
        const r = this.receipts.get(p.receiptNo);
        if (r) r.investigations.push({ investigationId: p.investigationId, status: "open", suspectFingerprint: p.fingerprint, reason: p.reason, openedAt: event.occurred_at, resolution: null });
        break;
      }
      case EventType.RECEIPT_INVESTIGATION_RESOLVED: {
        const r = this.receipts.get(p.receiptNo);
        const inv = r?.investigations.find((i) => i.investigationId === p.investigationId);
        if (inv) {
          inv.status = "resolved";
          inv.resolution = p.resolution;
          inv.resolvedAt = event.occurred_at;
        }
        break;
      }

      // ---- 通知 outbox ----
      case EventType.NOTIFICATION_SCHEDULED:
        this.notifications.set(p.idempotencyKey, {
          idempotencyKey: p.idempotencyKey,
          kind: p.kind,
          channel: p.channel,
          target: p.target,
          payload: p.payload,
          scheduledFor: p.scheduledFor,
          status: "scheduled",
          attempts: 0,
          holds: [],
        });
        break;
      case EventType.NOTIFICATION_HELD: {
        const n = this.notifications.get(p.idempotencyKey);
        // 仅待发通知可挂起；已发送/已取消的通知不得被乱序事件回退状态。
        if (n && n.status === "scheduled") {
          n.status = "held";
          n.holds.push({ reason: p.reason, since: event.occurred_at });
        }
        break;
      }
      case EventType.NOTIFICATION_RESCHEDULED: {
        const n = this.notifications.get(p.idempotencyKey);
        if (n && n.status === "held") {
          n.status = "scheduled";
          n.scheduledFor = p.scheduledFor ?? n.scheduledFor;
          n.backfill = true;
        }
        break;
      }
      case EventType.NOTIFICATION_CANCELLED: {
        const n = this.notifications.get(p.idempotencyKey);
        if (n && ["scheduled", "held"].includes(n.status)) n.status = "cancelled";
        break;
      }
      case EventType.NOTIFICATION_DISPATCHED: {
        const n = this.notifications.get(p.idempotencyKey);
        if (n && n.status === "scheduled") {
          n.status = "dispatched";
          n.attempts += 1;
          n.dispatchedAt = event.occurred_at;
          n.backfill = p.backfill ?? n.backfill ?? false;
        }
        break;
      }
      default:
        break;
    }
    return this;
  }

  static fromEvents(events) {
    const proj = new Projection();
    for (const e of events) proj.apply(e);
    return proj;
  }
}
