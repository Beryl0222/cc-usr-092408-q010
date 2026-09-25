import assert from "node:assert/strict";
import test from "node:test";

import { ErrorCode, LicenseStatus } from "../src/index.js";
import { buildScenario } from "./helpers.js";

test("五类档案分别建立，重复建档被拒绝", () => {
  const s = buildScenario();
  assert.throws(
    () => s.profiles.registerBrand({ brandId: "brand_mx", name: "重复", officeName: "x" }),
    (e) => e.code === ErrorCode.ALREADY_EXISTS
  );
  assert.ok(s.licensing.view().categories.has("cat_noodle"));
  assert.ok(s.licensing.view().standards.get("std_v1").status === "active");
});

test("转授权必须经全部规定角色批准后才生效", () => {
  const s = buildScenario();
  s.licensing.grantLicense({
    licenseId: "lic_sub_pending",
    brandId: "brand_mx",
    operatorId: "op_b",
    scope: { stores: ["stall_1"], categories: ["cat_noodle"] },
    parentLicenseId: "lic_root",
    standardVersionIds: ["std_v1"],
    grantedBy: { id: "u_a", role: "operator" },
  });
  // 仅品牌办公室批准，尚缺上游持有人批准
  s.licensing.decideApproval("lic_sub_pending", {
    role: "brand_office",
    decision: "approved",
    reviewer: { id: "u_office", role: "brand_office" },
  });
  assert.equal(s.licensing.view().licenses.get("lic_sub_pending").status, LicenseStatus.PENDING_APPROVAL);

  // 待批许可不得再转授
  assert.throws(
    () =>
      s.licensing.grantLicense({
        licenseId: "lic_grandchild",
        brandId: "brand_mx",
        operatorId: "op_b",
        scope: { stores: ["stall_1"], categories: ["cat_noodle"] },
        parentLicenseId: "lic_sub_pending",
        standardVersionIds: ["std_v1"],
        grantedBy: { id: "u_b", role: "operator" },
      }),
    (e) => e.code === ErrorCode.INVALID_STATE
  );

  s.licensing.decideApproval("lic_sub_pending", {
    role: "upstream_holder",
    decision: "approved",
    reviewer: { id: "u_a", role: "upstream_holder" },
  });
  assert.equal(s.licensing.view().licenses.get("lic_sub_pending").status, LicenseStatus.ACTIVE);
});

test("转授权范围超出上级（门店/品类）被拒绝并留痕，可被识别为越权转授", () => {
  const s = buildScenario();
  // stall_2 不在 lic_sub_b 范围内；cat_guobian 不在任何范围内
  assert.throws(
    () =>
      s.licensing.grantLicense({
        licenseId: "lic_oob_store",
        brandId: "brand_mx",
        operatorId: "op_b",
        scope: { stores: ["stall_2"], categories: ["cat_noodle"] },
        parentLicenseId: "lic_sub_b",
        standardVersionIds: ["std_v1"],
        grantedBy: { id: "u_b", role: "operator" },
      }),
    (e) => e.code === ErrorCode.SCOPE_EXCEEDED && e.details.ancestor_license_id === "lic_sub_b"
  );
  assert.throws(
    () =>
      s.licensing.grantLicense({
        licenseId: "lic_oob_cat",
        brandId: "brand_mx",
        operatorId: "op_b",
        scope: { stores: ["stall_1"], categories: ["cat_guobian"] },
        parentLicenseId: "lic_sub_b",
        standardVersionIds: ["std_v1"],
        grantedBy: { id: "u_b", role: "operator" },
      }),
    (e) => e.code === ErrorCode.SCOPE_EXCEEDED
  );

  const view = s.oversight.byBrand("brand_mx");
  const codes = view.findings.filter((f) => f.code === "unauthorized_sublicense");
  assert.equal(codes.length, 2);
  assert.deepEqual(codes[0].chain, ["lic_sub_b", "lic_root"]);
  // 越权许可从未生效
  assert.equal(s.licensing.view().licenses.has("lic_oob_store"), false);
});

test("转授权适用的标准版本不得超出上级许可", () => {
  const s = buildScenario();
  s.profiles.publishStandard({
    standardId: "std_v2",
    brandId: "brand_mx",
    versionNo: "v2.0",
    title: "新版标准",
    effectiveFrom: "2027-01-01T00:00:00+08:00",
    clauses: [],
  });
  assert.throws(
    () =>
      s.licensing.grantLicense({
        licenseId: "lic_oob_std",
        brandId: "brand_mx",
        operatorId: "op_b",
        scope: { stores: ["stall_1"], categories: ["cat_noodle"] },
        parentLicenseId: "lic_sub_b",
        standardVersionIds: ["std_v2"],
        grantedBy: { id: "u_b", role: "operator" },
      }),
    (e) => e.code === ErrorCode.SCOPE_EXCEEDED && e.details.standard_version_id === "std_v2"
  );
});

test("主体变更：旧许可关闭但历史责任留存；无承接许可时标记无授权实际经营；不连带同门店其他主体的许可", () => {
  const s = buildScenario();
  const result = s.licensing.reportOperatorChange({
    storeId: "stall_1",
    previousOperatorId: "op_a",
    actualOperatorId: "op_c",
    actualOperatorName: "陈某",
    discoveredVia: "complaint_20260925",
  });

  assert.deepEqual(result.closedLicenses, ["lic_root"]);
  const root = s.licensing.view().licenses.get("lic_root");
  assert.equal(root.status, "closed_by_change");
  assert.equal(root.closure.responsibilityRetained, true);
  assert.deepEqual(root.closure.retainedFor, ["历史巡检问题", "历史处罚", "历史申诉"]);

  // 同门店另一主体 op_b 的合规品类许可不受连带影响
  assert.equal(s.licensing.view().licenses.get("lic_sub_b").status, LicenseStatus.ACTIVE);

  const view = s.oversight.byStore("stall_1");
  const unlicensed = view.findings.find((f) => f.code === "actual_operator_unlicensed");
  assert.ok(unlicensed, "应识别实际经营者无有效许可");
  assert.equal(unlicensed.actualOperatorId, "op_c");
  assert.deepEqual(view.stores[0].actualOperatorChanges[0].previousOperatorId, "op_a");
});

test("主体变更后新主体获批许可，不再标记无授权经营", () => {
  const s = buildScenario();
  s.licensing.reportOperatorChange({
    storeId: "stall_1",
    previousOperatorId: "op_a",
    actualOperatorId: "op_c",
    actualOperatorName: "陈某",
  });
  s.licensing.grantLicense({
    licenseId: "lic_c",
    brandId: "brand_mx",
    operatorId: "op_c",
    scope: { stores: ["stall_1"], categories: ["cat_noodle", "cat_wonton"] },
    standardVersionIds: ["std_v1"],
    grantedBy: { id: "u_office", role: "brand_office" },
  });
  s.licensing.decideApproval("lic_c", {
    role: "brand_office",
    decision: "approved",
    reviewer: { id: "u_office", role: "brand_office" },
  });
  const view = s.oversight.byStore("stall_1");
  assert.ok(view.stores[0].currentLicensedOperators.includes("op_c"));
});

test("授权链可从任一子许可穿透回溯到品牌根", () => {
  const s = buildScenario();
  const chain = s.licensing.chainOf("lic_sub_b").map((l) => l.licenseId);
  assert.deepEqual(chain, ["lic_sub_b", "lic_root"]);
  const covering = s.licensing.licensesCoveringStore("stall_1").map((l) => l.licenseId).sort();
  assert.deepEqual(covering, ["lic_root", "lic_sub_b"]);
});

test("乐观并发：过期版本号写入被拒绝，事件不可原地改写", () => {
  const s = buildScenario();
  const v = s.store.versionOf("lic_root");
  s.licensing.revokeLicense("lic_root", { reason: "测试注销", actor: { id: "u_office", role: "brand_office" } });
  assert.throws(
    () =>
      s.store.append(
        {
          event_type: "LICENSE_SCOPE_SUSPENDED",
          aggregate_type: "license",
          aggregate_id: "lic_root",
          summary: "迟到事件",
          payload: {},
        },
        v
      ),
    (e) => e.code === ErrorCode.CONFLICT
  );
});
