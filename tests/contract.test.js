import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { suggestRisk } from "../src/risk.js";
import { buildWorld, T } from "./helpers/world.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("完整场景产生的每个事件都满足信封约定，且类型/聚合类型在契约枚举内", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const eventTypes = new Set(schema.properties.event_type.enum);
  const aggregateTypes = new Set(schema.properties.aggregate_type.enum);

  const g = buildWorld();
  g.auth.grantRoot(
    { licenseId: "L0", brandId: "b1", holderSubjectId: "s1", scope: { stores: ["st1"], categories: ["cat-noodle", "cat-snack"] }, standardVersionId: "std-v1", grantedAt: T.grant },
    "admin"
  );
  g.auth.requestSublicense(
    { requestId: "req1", parentLicenseId: "L0", toSubjectId: "s2", scope: { stores: ["st1"], categories: ["cat-noodle"] }, standardVersionId: "std-v1", requestedAt: "2026-03-01T00:00:00Z" },
    "admin"
  );
  g.auth.approveSublicense({ requestId: "req1", licenseId: "L1", approvedAt: "2026-03-02T00:00:00Z" }, "admin");
  g.register.changeStallOperator({ storeId: "st1", stallId: "stall-A", toSubjectId: "s2", changedAt: "2026-08-01T00:00:00Z" }, "admin");
  g.cases.complain({ caseId: "c1", storeId: "st1", stallId: "stall-A", brandId: "b1", content: "异味", receivedAt: "2026-09-20T00:00:00Z" }, { subjectId: "s2" });
  const findings = [{ item: "生熟分开", detail: "变质", severity: "critical", evidenceIds: ["ev1"] }];
  const evidence = [{ evidenceId: "ev1", type: "photo", content: { h: 1 } }];
  const advisory = suggestRisk({ findings, evidence });
  g.cases.inspect({ caseId: "c1", inspectedAt: T.inspect, standardVersionId: "std-v1", findings, evidence, advisory }, "insp1");
  g.cases.confirmRisk({ caseId: "c1", confirmedLevel: "high", confirmedAt: T.inspect }, "insp1");
  g.cases.decide({ caseId: "c1", kind: "partial_stop_sale", licenseId: "L1", scope: { categories: ["cat-noodle"] }, reason: "变质", decidedAt: T.decide, suspensionId: "sus1" }, "insp1");
  g.cases.submitRemediation({ caseId: "c1", materials: [{ materialId: "m1", content: { doc: "报告" } }], submittedAt: "2026-09-24T00:00:00Z" }, { subjectId: "s2" });
  g.cases.review({ caseId: "c1", reviewId: "rv1", decision: "approved", reviewedAt: T.review }, "rev1");

  const events = g.rawEvents();
  assert.ok(events.length > 10);
  const versionByAggregate = new Map();
  for (const e of events) {
    assert.deepEqual(validateEvent(e), [], `事件 ${e.event_id} 信封校验失败`);
    assert.ok(eventTypes.has(e.event_type), `未登记的事件类型：${e.event_type}`);
    assert.ok(aggregateTypes.has(e.aggregate_type), `未登记的聚合类型：${e.aggregate_type}`);
    assert.match(e.content_fingerprint ?? "", /^sha256:/);
    // 每聚合版本号从 1 单调递增
    const v = versionByAggregate.get(e.aggregate_id) ?? 0;
    assert.equal(e.version, v + 1, `聚合 ${e.aggregate_id} 版本不连续`);
    versionByAggregate.set(e.aggregate_id, e.version);
  }
});
