import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { buildWorld, T } from "./helpers/world.js";

function rootLicense(g, overrides = {}) {
  return g.auth.grantRoot(
    {
      licenseId: "L0",
      brandId: "b1",
      holderSubjectId: "s1",
      scope: { stores: ["st1"], categories: ["cat-noodle", "cat-snack"] },
      standardVersionId: "std-v1",
      grantedAt: T.grant,
      ...overrides,
    },
    "admin"
  );
}

test("根授权建档并可回溯授权链", () => {
  const g = buildWorld();
  rootLicense(g);
  g.auth.requestSublicense(
    { requestId: "req1", parentLicenseId: "L0", toSubjectId: "s2", scope: { stores: ["st1"], categories: ["cat-noodle"] }, standardVersionId: "std-v1", requestedAt: "2026-03-01T00:00:00Z" },
    "admin"
  );
  g.auth.approveSublicense({ requestId: "req1", licenseId: "L1", approvedAt: "2026-03-02T00:00:00Z" }, "admin");

  const chain = g.licenses().chainOf("L1").map((l) => l.licenseId);
  assert.deepEqual(chain, ["L1", "L0"]);
  assert.equal(g.auth.license("L1").depth, 1);
});

test("转授权超出上级范围被拒绝（越权转授）", () => {
  const g = buildWorld();
  rootLicense(g);
  assert.throws(
    () =>
      g.auth.requestSublicense(
        { requestId: "req-bad", parentLicenseId: "L0", toSubjectId: "s2", scope: { stores: ["st1", "st2"], categories: ["cat-noodle"] }, standardVersionId: "std-v1", requestedAt: "2026-03-01T00:00:00Z" },
        "admin"
      ),
    (e) => e instanceof DomainError && e.code === "SCOPE_EXCEEDED"
  );
});

test("转授权要求品类也落在上级范围内", () => {
  const g = buildWorld();
  rootLicense(g, { scope: { stores: ["st1"], categories: ["cat-noodle"] } });
  assert.throws(
    () =>
      g.auth.requestSublicense(
        { requestId: "req-bad2", parentLicenseId: "L0", toSubjectId: "s2", scope: { stores: ["st1"], categories: ["cat-snack"] }, standardVersionId: "std-v1", requestedAt: "2026-03-01T00:00:00Z" },
        "admin"
      ),
    (e) => e.code === "SCOPE_EXCEEDED"
  );
});

test("转授权未经品牌办批准不会生成下级许可", () => {
  const g = buildWorld();
  rootLicense(g);
  g.auth.requestSublicense(
    { requestId: "req1", parentLicenseId: "L0", toSubjectId: "s2", scope: { stores: ["st1"], categories: ["cat-noodle"] }, standardVersionId: "std-v1", requestedAt: "2026-03-01T00:00:00Z" },
    "admin"
  );
  assert.equal(g.auth.tryLicense("L1"), null);
  // 非品牌办角色不能批准
  g.register.staff({ staffId: "notadmin", name: "旁人", roles: ["inspector"] });
  assert.throws(() => g.auth.approveSublicense({ requestId: "req1", licenseId: "L1", approvedAt: "2026-03-02T00:00:00Z" }, "notadmin"), (e) => e.code === "FORBIDDEN");
});

test("待批期间上级范围被暂停，批准时再次拦截", () => {
  const g = buildWorld();
  rootLicense(g);
  g.auth.requestSublicense(
    { requestId: "req1", parentLicenseId: "L0", toSubjectId: "s2", scope: { stores: ["st1"], categories: ["cat-noodle"] }, standardVersionId: "std-v1", requestedAt: "2026-03-01T00:00:00Z" },
    "admin"
  );
  // 上级面食被停售后，待批的面食转授权失去有效来源
  g.auth.suspend({ licenseId: "L0", scope: { stores: ["st1"], categories: ["cat-noodle"] }, caseId: "c-pre", reason: "调查", suspendedAt: "2026-03-01T12:00:00Z" }, "admin");
  assert.throws(
    () => g.auth.approveSublicense({ requestId: "req1", licenseId: "L1", approvedAt: "2026-03-02T00:00:00Z" }, "admin"),
    (e) => e.code === "SCOPE_EXCEEDED"
  );
});

test("按范围暂停后，合规品类仍处于有效范围，复查仅恢复受影响范围", () => {
  const g = buildWorld();
  rootLicense(g);
  g.auth.suspend({ licenseId: "L0", scope: { stores: ["st1"], categories: ["cat-noodle"] }, caseId: "c1", reason: "面食问题", suspendedAt: T.decide, suspensionId: "sus1" }, "admin");

  let license = g.auth.license("L0");
  assert.equal(license.status, "partially_suspended");
  assert.deepEqual(license.effectiveScope.categories.sort(), ["cat-snack"]); // 小吃不受连带

  g.auth.resume({ licenseId: "L0", caseId: "c1", restoreScope: { stores: ["st1"], categories: ["cat-noodle"] }, resumedAt: T.review, reviewId: "rv1" }, "rev1");
  license = g.auth.license("L0");
  assert.equal(license.status, "active");
  assert.deepEqual(license.effectiveScope.categories.sort(), ["cat-noodle", "cat-snack"]);
});

test("恢复范围不能超出原暂停范围", () => {
  const g = buildWorld();
  rootLicense(g);
  g.auth.suspend({ licenseId: "L0", scope: { stores: ["st1"], categories: ["cat-noodle"] }, caseId: "c1", reason: "x", suspendedAt: T.decide, suspensionId: "sus1" }, "admin");
  assert.throws(
    () => g.auth.resume({ licenseId: "L0", caseId: "c1", restoreScope: { stores: ["st1"], categories: ["cat-snack"] }, resumedAt: T.review }, "rev1"),
    (e) => e.code === "EMPTY_RESTORE_SCOPE"
  );
});

test("吊销整条许可会影响全部范围，状态终局且不可转授", () => {
  const g = buildWorld();
  rootLicense(g);
  g.auth.revoke({ licenseId: "L0", caseId: "c-z", reason: "严重违规", revokedAt: "2026-04-01T00:00:00Z" }, "admin");
  assert.equal(g.auth.license("L0").status, "revoked");
  assert.throws(
    () =>
      g.auth.requestSublicense(
        { requestId: "req-x", parentLicenseId: "L0", toSubjectId: "s2", scope: { stores: ["st1"], categories: ["cat-noodle"] }, standardVersionId: "std-v1", requestedAt: "2026-04-02T00:00:00Z" },
        "admin"
      ),
    (e) => e.code === "PARENT_REVOKED"
  );
});
