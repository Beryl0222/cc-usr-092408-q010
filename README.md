# 地方小吃公用品牌穿透治理

针对「挂公用品牌招牌的档口被投诉后，沿加盟关系追查才发现实际经营者已变更、
许可与适用品类仍停留在原主体；直接吊销又会连带同店合规品类」这一问题，
本服务实现能够**穿透到实际档口**的许可与整改流程。

纯 Node.js ESM、零运行时依赖，采用事件溯源：事件一经接收不改写，业务更正产生后继记录。

## 核心能力

- **五类对象分别建档**：品牌授权、经营主体、门店（含档口）、品类、标准版本；人员角色单独建档。
- **可穿透的授权链**：根授权 → 多级转授权。转授权不得超出上级范围，且必须经品牌办**批准**后才生效。
- **范围精确到「门店 × 品类」格点**：局部停售只停问题格点，同一门店的合规品类不被连带。
- **巡检绑定当时标准与证据**：固化检查时点的标准版本快照（含内容指纹）与证据指纹；事后换版不改变办案依据。
- **自动风险分级仅供参考**：检查员确认（可采纳或改级）后，才能选择限期整改、局部停售或暂停许可。
- **主体变化保留历史责任**：档口换经营者是追加事实；巡检按「检查当时」的实际经营者锁定责任主体，历任主体留档。
- **申诉边界**：只冻结争议**处罚**（如限期整改），**不解除食品安全措施**（停售/暂停）；裁决后解除冻结。
- **职责分离的整改复核**：整改材料由另一角色复核，复核人不得是本案巡检人或处置决定人。
- **复查仅恢复受影响范围**：按本案造成的暂停格点恢复，其他案件与合规品类不受影响。
- **离线归并与到期补齐**：重复回执按内容指纹归并；同回执异内容保留并转调查；中断期到期的升级/通知恢复后补齐，且每个任务只执行一次。
- **监管三入口穿透视图**：从品牌、门店或处罚（案件）任一入口进入，都能看到完整授权链、适用标准、证据、申诉与恢复决定。
- **冲突识别**：越权转授、上级范围缺口、实际经营者与许可错位、并发复核冲突、食安措施被误解除。

## 目录结构

| 路径 | 职责 |
| --- | --- |
| `src/events.js` | 不可变事件存储：每聚合单调版本、期望版本乐观锁、内容指纹、可注入时钟 |
| `src/fingerprint.js` | 规范化 JSON 的 sha256 内容指纹 |
| `src/scope.js` | 授权范围与「门店×品类」格点运算（包含、交集、扣减、可转授判定） |
| `src/registry.js` | 品牌/主体/门店/档口/品类/标准版本/人员建档与只读折叠；档口经营者时间线 |
| `src/authorization.js` | 根授权、转授申请/批准/驳回、按范围暂停、按案件格点恢复、吊销；授权链折叠 |
| `src/risk.js` | 自动风险分级建议（始终标记 advisory） |
| `src/compliance.js` | 投诉、巡检、风险确认、三种处置、申诉冻结/解除、整改提交、分离角色复核 |
| `src/sync.js` | 离线上传回执归并/异内容调查、到期升级与通知的幂等调度与中断补齐 |
| `src/oversight.js` | 品牌/门店/处罚三入口穿透档案与冲突识别 |
| `src/app.js` | 装配门面 `createGovernance()` |
| `src/validator.js` | 事件信封最小结构校验 |
| `contracts/domain.schema.json` | 事件类型与聚合类型契约枚举 |
| `tests/` | 授权、办案、离线同步、监管视图、契约共 30+ 用例 |

## 关键事件流

```
BRAND/SUBJECT/STORE/CATEGORY/STANDARD/STAFF _REGISTERED
LICENSE_GRANTED（根授权）
  SUBLICENSE_REQUESTED ──批准──▶ SUBLICENSE_APPROVED + LICENSE_GRANTED（下级）
                         └驳回──▶ SUBLICENSE_REJECTED
STALL_OPERATOR_CHANGED（追加，不覆盖历史）
COMPLAINT_FILED → INSPECTION_RECORDED（绑定标准快照+证据指纹+建议风险）
  → RISK_CONFIRMED（检查员确认）
  → DISPOSITION_DECIDED（rectify | partial_stop_sale | suspend_license）
      └ 后两者同步产生 LICENSE_SUSPENDED（食品安全措施）
APPEAL_FILED →（可）PENALTY_HELD_BY_APPEAL → APPEAL_RESOLVED → PENALTY_HOLD_RELEASED
REMEDIATION_SUBMITTED → REVIEW_DECIDED（另一角色）
  └ approved：LICENSE_RESUMED（仅本案格点）+ REMEDIATION_CLOSED
  └ rejected：维持措施，可再次提交
UPLOAD_RECEIVED / RECEIPT_DELIVERED / RECEIPT_CONTENT_DIVERGED
DUE_TASK_SCHEDULED → DUE_TASK_FIRED（escalation→ESCALATION_RECORDED / notification）
OUTAGE_STARTED / OUTAGE_ENDED（恢复时补齐到期任务）
```

## 使用示例

```js
import { createGovernance } from "./src/app.js";
import { suggestRisk } from "./src/risk.js";

const g = createGovernance();
// 建档（品牌/主体/门店/品类/标准/人员）……
g.auth.grantRoot({ licenseId: "L0", brandId, holderSubjectId, scope, standardVersionId, grantedAt }, admin);
g.auth.requestSublicense({ requestId, parentLicenseId: "L0", toSubjectId, scope, standardVersionId }, admin);
g.auth.approveSublicense({ requestId, licenseId: "L1", approvedAt }, admin); // 不超范围才批准

g.cases.inspect({ caseId, inspectedAt, standardVersionId, findings, evidence,
                  advisory: suggestRisk({ findings, evidence }) }, inspector);
g.cases.confirmRisk({ caseId, confirmedLevel: "high", confirmedAt }, inspector); // 建议须确认
g.cases.decide({ caseId, kind: "partial_stop_sale", licenseId: "L1",
                 scope: { categories: ["cat-noodle"] }, decidedAt }, inspector); // 只停面食

g.oversight.fromStore("st1");   // 门店入口
g.oversight.fromBrand(brand);   // 品牌入口
g.oversight.fromCase(caseId);   // 处罚入口
g.oversight.detectConflicts();  // 越权转授 / 主体错位 / 并发复核等
```

### 并发复核

复核接受 `expectedVersion`（案件当前事件数）。两名复核人并发提交时，后者在产生任何
恢复/关闭副作用之前收到 `VERSION_CONFLICT`，只读投影还会把绕过锁的多结论数据标记为
`concurrent_review_conflict`。

## 本地检查

```bash
npm test     # node --test
npm run build # 对 src/*.js 做语法检查
```

## 领域边界

事件标识、发生时间与版本不可原地改写；范围最小化读取涉及个人与商业敏感信息的字段。
当前实现使用内存事件存储，事件结构即契约，可直接替换为持久化的仅追加日志。
