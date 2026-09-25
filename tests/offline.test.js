import assert from "node:assert/strict";
import test from "node:test";

import { ErrorCode, contentFingerprint } from "../src/index.js";
import { buildScenario } from "./helpers.js";

const contentA = {
  inspectedAt: "2026-09-25T10:00:00+08:00",
  storeId: "stall_1",
  standardVersionId: "std_v1",
  findings: [{ clauseId: "c2", result: "fail" }],
};
const contentAPrime = {
  // 键顺序不同、语义相同 → 指纹必须一致
  standardVersionId: "std_v1",
  storeId: "stall_1",
  findings: [{ result: "fail", clauseId: "c2" }],
  inspectedAt: "2026-09-25T10:00:00+08:00",
};
const contentB = {
  inspectedAt: "2026-09-25T10:00:00+08:00",
  storeId: "stall_1",
  standardVersionId: "std_v1",
  findings: [{ clauseId: "c2", result: "pass" }], // 内容不同
};

test("内容指纹对键顺序不敏感", () => {
  assert.equal(contentFingerprint(contentA), contentFingerprint(contentAPrime));
  assert.notEqual(contentFingerprint(contentA), contentFingerprint(contentB));
});

test("同回执号 + 同内容指纹：重复上传按指纹归并，不重复处理", () => {
  const s = buildScenario();
  const first = s.offline.upload({ receiptNo: "RC-1001", deviceId: "dev-1", content: contentA });
  assert.equal(first.outcome, "registered");
  // 第二台设备、不同时间、键顺序不同
  const second = s.offline.upload({
    receiptNo: "RC-1001",
    deviceId: "dev-2",
    uploadedAt: "2026-09-25T12:00:00+08:00",
    content: contentAPrime,
  });
  assert.equal(second.outcome, "merged");
  assert.equal(second.merged, true);

  const r = s.offline.view().receipts.get("RC-1001");
  assert.equal(r.uploads.length, 2);
  assert.equal(r.mergedCount, 1);
  assert.equal(r.investigations.length, 0);
});

test("同回执号 + 异内容：不归并，保留双方并开立差异调查，原始内容不被覆盖", () => {
  const s = buildScenario();
  s.offline.upload({ receiptNo: "RC-1002", deviceId: "dev-1", content: contentA });
  let err;
  try {
    s.offline.upload({ receiptNo: "RC-1002", deviceId: "dev-9", content: contentB });
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, ErrorCode.CONTENT_MISMATCH);
  assert.ok(err.details.investigationId);

  const r = s.offline.view().receipts.get("RC-1002");
  // 原始 canonical 内容保留
  assert.equal(r.canonicalFingerprint, contentFingerprint(contentA));
  assert.equal(r.uploads.length, 1);
  assert.equal(r.investigations.length, 1);
  assert.equal(r.investigations[0].status, "open");
  assert.equal(r.investigations[0].suspectFingerprint, contentFingerprint(contentB));

  // 调查结案
  s.offline.resolveInvestigation({
    receiptNo: "RC-1002",
    investigationId: err.details.investigationId,
    resolution: "suspect_confirmed",
    decidedBy: { id: "u_reg", role: "regulator" },
  });
  assert.equal(s.offline.view().receipts.get("RC-1002").investigations[0].status, "resolved");
});

test("同一异内容重复上报不会重复开立调查", () => {
  const s = buildScenario();
  s.offline.upload({ receiptNo: "RC-1003", content: contentA });
  const boom = () => s.offline.upload({ receiptNo: "RC-1003", content: contentB });
  assert.throws(boom, (e) => e.code === ErrorCode.CONTENT_MISMATCH);
  assert.throws(boom, (e) => e.code === ErrorCode.CONTENT_MISMATCH);
  const r = s.offline.view().receipts.get("RC-1003");
  assert.equal(r.investigations.length, 1);
});
