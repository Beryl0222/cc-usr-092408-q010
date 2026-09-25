// 聚合类型（与 contracts/domain.schema.json 保持一致）
export const Aggregate = Object.freeze({
  BRAND: "brand", // 公用品牌（品牌办公室为其管理方）
  OPERATOR: "operator", // 经营主体
  STORE: "store", // 门店 / 物理档口
  CATEGORY: "category", // 适用品类（如：拌面、扁肉、锅边）
  STANDARD: "standard_version", // 标准版本
  LICENSE: "license", // 品牌许可/授权链节点
  CASE: "compliance_case", // 巡检案件（问题、处置、申诉、整改）
  RECEIPT: "offline_receipt", // 离线回执归并记录
});

// 许可状态
export const LicenseStatus = Object.freeze({
  PENDING_APPROVAL: "pending_approval", // 已创建、等待上级批准
  ACTIVE: "active",
  PAUSED: "paused", // 暂停许可（整体或按范围，见 affected_scope）
  EXPIRED: "expired",
  REVOKED: "revoked",
  REJECTED: "rejected",
});

// 处置类型
export const Action = Object.freeze({
  RECTIFY_WITH_DEADLINE: "rectify_with_deadline", // 限期整改
  PARTIAL_SUSPENSION: "partial_suspension", // 局部停售（按品类）
  LICENSE_PAUSE: "license_pause", // 暂停许可
});

// 风险等级：自动分级仅作检查员参考，需人工确认后才驱动处置。
export const RiskLevel = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
});

// 申诉/处置状态
export const CaseStatus = Object.freeze({
  OPEN: "open",
  ACTION_DECIDED: "action_decided",
  APPEALED: "appealed", // 争议处罚已冻结，食品安全措施继续有效
  REMEDIATION_SUBMITTED: "remediation_submitted",
  REINSPECTING: "reinspecting",
  CLOSED: "closed",
});

export const IssueStatus = Object.freeze({
  OPEN: "open",
  RECTIFYING: "rectifying",
  SUSPENDED_SCOPE: "suspended_scope",
  REMEDIATION_SUBMITTED: "remediation_submitted",
  PASSED: "passed", // 复查通过
  FAILED: "failed", // 复查不通过
});

export const ReviewResult = Object.freeze({
  APPROVED: "approved",
  REJECTED: "rejected",
  SUPERSEDED: "superseded", // 并发冲突：本次复核被另一复核覆盖
});

// 通知通道（中断恢复后按幂等键补发）
export const Channel = Object.freeze({
  OPERATOR: "operator",
  BRAND_OFFICE: "brand_office",
  REGULATOR: "regulator",
});

export const NotificationKind = Object.freeze({
  RISK_ESCALATION: "risk_escalation", // 升级（高风险/逾期）
  ACTION_NOTICE: "action_notice", // 处置通知
  DEADLINE_REMINDER: "deadline_reminder",
  REINSTATEMENT_NOTICE: "reinstatement_notice",
  APPEAL_RECEIVED: "appeal_received",
});

// 两个适用范围是否相同（品类集合 + 门店集合一致，顺序无关）。
export function sameScope(a, b) {
  const ax = [...(a?.categories ?? [])].sort();
  const bx = [...(b?.categories ?? [])].sort();
  if (ax.length !== bx.length || ax.some((c, i) => c !== bx[i])) return false;
  const as = [...(a?.stores ?? [])].sort();
  const bs = [...(b?.stores ?? [])].sort();
  return as.length === bs.length && as.every((s, i) => s === bs[i]);
}

// 转授权范围判定：子范围中的每个门店、每个品类都必须出现在上级范围内。
// 上级某维度为空集合表示该维度不限制（如只授权到门店粒度即覆盖其全部品类）。
export function isWithinScope(child, parent) {
  const parentStores = parent?.stores ?? [];
  const parentCategories = parent?.categories ?? [];
  if (parentStores.length) {
    for (const storeId of child?.stores ?? []) {
      if (!parentStores.includes(storeId)) return false;
    }
  }
  if (parentCategories.length) {
    for (const categoryId of child?.categories ?? []) {
      if (!parentCategories.includes(categoryId)) return false;
    }
  }
  return true;
}

export function scopeKey(scope) {
  return `${[...(scope?.stores ?? [])].sort().join("|")}#${[...(scope?.categories ?? [])].sort().join("|")}`;
}

export function mergeScope(a, b) {
  return {
    stores: [...new Set([...(a?.stores ?? []), ...(b?.stores ?? [])])],
    categories: [...new Set([...(a?.categories ?? []), ...(b?.categories ?? [])])],
  };
}

// 范围交集。b 在某维度为空集合表示该维度“不另作限制”（如整店恢复 = 该店全部品类）。
export function intersectScope(a, b) {
  const bs = b?.stores ?? [];
  const bc = b?.categories ?? [];
  return {
    stores: bs.length ? (a?.stores ?? []).filter((s) => bs.includes(s)) : [...(a?.stores ?? [])],
    categories: bc.length ? (a?.categories ?? []).filter((c) => bc.includes(c)) : [...(a?.categories ?? [])],
  };
}

export function isEmptyScope(scope) {
  return (scope?.stores ?? []).length === 0 && (scope?.categories ?? []).length === 0;
}

// 自动风险分级：只依据证据与问题严重度给出建议，检查员可以改判。
const severityWeight = Object.freeze({ low: 1, medium: 2, high: 3 });

export function suggestRisk(issues) {
  let score = 0;
  for (const issue of issues) {
    score += severityWeight[issue.severity] ?? 1;
    if (issue.foodSafetyCritical) score += 2; // 食品安全关键项加权
  }
  if (score >= 5) return RiskLevel.HIGH;
  if (score >= 2) return RiskLevel.MEDIUM;
  return RiskLevel.LOW;
}
