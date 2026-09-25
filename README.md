# 地方小吃公用品牌穿透治理

针对「投诉挂公用品牌招牌的档口后，沿加盟关系追查才发现实际经营者已变更，而品牌许可与适用品类仍停留在上一个主体；直接吊销又会连带同门店合规品类」这一场景，实现可以**穿透到实际档口**的许可与整改流程。

本服务采用事件溯源：所有业务动作都只追加不可变事件，更正产生后继记录；读模型由事件流投影得到。

## 能力与规则映射

| 业务要求 | 实现位置 / 规则 |
| --- | --- |
| 品牌授权、经营主体、门店、品类、标准版本分别建档 | `ProfileService`（`src/services/profiles.js`），五类聚合独立 ID；标准换版只新增版本，旧版本保留用于历史证据绑定 |
| 穿透到实际档口的授权链 | `LicenseService.grantLicense` / `chainOf` / `licensesCoveringStore`；转授许可携带 `parentLicenseId`，可逐级回溯到品牌根 |
| 转授权不得超出上级范围 | 授权时沿整条祖先链校验门店、品类与标准版本（`isWithinScope`）；越权授予被**拒绝并落 `UNAUTHORIZED_OPERATION_DETECTED` 留痕** |
| 转授权需要批准 | 许可创建后为 `pending_approval`，规定角色（品牌办公室，跨主体时加上游持有人）全部批准才生效；未批许可不得再转授 |
| 主体变化保留此前责任 | `reportOperatorChange` 关闭旧许可（`LICENSE_CLOSED_BY_CHANGE`，`responsibilityRetained=true`），但历史巡检/处罚/申诉仍归原主体；不连带同门店其他主体的合规许可 |
| 巡检问题绑定检查当时标准与证据 | `recordIssue` 快照 `standardVersionId`、证据哈希、检查时责任主体；事后标准废止/换版不改写 |
| 自动风险分级仅供参考 | `autoSuggest` 只写 `RISK_SUGGESTED`；必须检查员 `confirmRisk`（可改判）后才允许处置 |
| 限期整改 / 局部停售 / 暂停许可 | `decideEnforcement` 三选一；局部停售只在许可上施加涉事品类的范围限制（许可仍 active），暂停许可使许可整体 `paused` |
| 申诉只冻结争议处罚，不解除食品安全措施 | `fileAppeal` 挂起相关通知并标记 `frozenByAppeal`；许可上的停售/暂停限制一条不动；申诉结论 `upheld/overturned/adjusted` |
| 整改材料另一角色复核 | `reviewRemediation` 拒绝提交人本人与原检查员；两个复核人并发给出互斥结论时两种意见都保留，落 `REMEDIATION_REVIEW_CONFLICTED` 并阻断恢复，须显式裁定 |
| 复查通过仅恢复受影响范围 | `decideReinstatement` 按「本次新通过问题 × 请求范围 × 现存限制」逐限制差集解除；未通过部分继续停售；案件全部问题通过后取消未决逾期升级 |
| 离线上传按内容指纹归并 | `OfflineIngestService`：稳定序列化 + SHA-256；同回执号同指纹归并（幂等），同回执号异内容不归并、保留双方并开立差异调查 |
| 中断恢复补齐、不重复执行 | 通知为事务性 outbox，幂等键唯一，`recover()` 对中断期间到期项 backfill 补发；已派发的任何扫描都不会再发；申诉挂起/取消参与状态机 |
| 监管统一视图 | `OversightService.byBrand / byStore / byEnforcement` 三入口返回同一份事实：授权链森林、适用标准、证据、处置、申诉、复核、复查、恢复，并派生越权转授、无授权实际经营、未批生效、并发复核冲突等 findings |

## 目录结构

```
contracts/domain.schema.json   领域事件契约（事件类型与聚合类型枚举）
src/domain/
  event-store.js               只追加事件存储 + 乐观并发
  projection.js                事件 → 当前读模型
  constants.js                 状态枚举、范围运算、自动分级建议
  fingerprint.js               稳定序列化与内容指纹
  event-types.js / errors.js
src/services/
  profiles.js                  五类建档
  licensing.js                 授权链、批准、主体变更
  compliance.js                巡检、处置、申诉、整改复核、复查恢复
  offline-ingest.js            离线回执归并与差异调查
  notifications.js             通知 outbox：挂起/补发/取消，幂等
  oversight.js                 监管三入口统一视图与冲突识别
src/index.js                   装配门面 createApplication()
tests/                         node:test 用例（含端到端叙事场景）
data/sample.json               示例事件
```

## 快速使用

```js
import { createApplication } from "./src/index.js";

const app = createApplication();
app.profiles.registerBrand({ brandId: "b1", name: "闽地小吃", officeName: "品牌办公室" });
// ...registerOperator / registerStore / registerCategory / publishStandard
app.licensing.grantLicense({ brandId: "b1", operatorId: "op1",
  scope: { stores: ["stall_1"], categories: ["cat_noodle"] }, /* ... */ });
app.licensing.decideApproval(licenseId, { role: "brand_office", decision: "approved", reviewer });

const view = app.oversight.byStore("stall_1");
// view.authorizationChain / applicableStandards / cases / findings
```

离线与中断恢复：

```js
app.offline.upload({ receiptNo: "RC-1", deviceId: "t1", content }); // 第二次同内容 → merged
app.clock.set("2026-10-02T08:00:00+08:00");
app.notifications.recover();   // 补齐中断期间到期的升级/通知，幂等不重复
```

## 本地检查

```bash
npm test     # node --test（36 个用例）
npm run build # 对全部源文件做 node --check
```

所有命令均可在单个 Linux 容器内执行，不依赖外部服务。

## 领域边界

事件标识、发生时间与版本一旦写入不可原地改写，业务更正通过后继事件表达。涉及个人或商业敏感信息时，调用方只读取完成职责所必需的字段。
