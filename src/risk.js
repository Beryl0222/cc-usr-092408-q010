// 自动风险分级：只产出「建议」，检查员必须显式确认后才能作为处置依据。
//
// 规则（可随治理实践调整）：
//   高   存在食安类严重问题，或命中关键项且证据缺失；
//   中   命中关键项，或一般问题数 >= 3；
//   低   其余情况。
const HIGH_KEYWORDS = ["食品安全", "变质", "致病菌", "腐败", "中毒", "交叉污染", "过期"];

export function suggestRisk({ findings = [], evidence = [], standardVersionId = null } = {}) {
  const text = findings.map((f) => `${f.item} ${f.detail ?? ""}`).join(" ");
  const safetyHit = HIGH_KEYWORDS.some((k) => text.includes(k));
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const missingEvidence = findings.some((f) => f.severity === "critical" && !(f.evidenceId || f.evidenceRef));

  let level = "low";
  if (safetyHit || (criticalCount > 0 && (missingEvidence || evidence.length === 0))) level = "high";
  else if (criticalCount > 0 || findings.length >= 3) level = "medium";

  return {
    suggestedLevel: level,
    ruleHits: {
      safetyHit,
      criticalCount,
      missingCriticalEvidence: missingEvidence,
      evidenceCount: evidence.length,
    },
    standardVersionId,
    advisory: true, // 始终标记为建议
  };
}
