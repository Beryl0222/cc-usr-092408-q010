// 测试夹具：构建一个可复用的典型治理场景。
//
// 品牌「闽地小吃」：
//   主体 op_a（老王，原经营者）持有根许可 lic_root，覆盖门店 stall_1 的 cat_noodle / cat_wonton；
//   主体 op_b 为 op_a 的合作档口（转授），覆盖 stall_1 的 cat_noodle，需要批准；
//   标准 std_v1 已发布。
import { createApplication, MutableClock } from "../src/index.js";

export function buildScenario(options = {}) {
  const app = createApplication(options);
  const { profiles, licensing } = app;

  profiles.registerBrand({ brandId: "brand_mx", name: "闽地小吃", officeName: "闽地小吃品牌办公室" });
  profiles.registerOperator({
    operatorId: "op_a",
    name: "老王餐饮管理部",
    creditCode: "91350100A1X",
    legalRepresentative: "王某某",
  });
  profiles.registerOperator({
    operatorId: "op_b",
    name: "林某合作档口",
    creditCode: "91350100B2Y",
    legalRepresentative: "林某",
  });
  profiles.registerOperator({
    operatorId: "op_c",
    name: "陈某（实际接手人）",
    creditCode: "91350100C3Z",
    legalRepresentative: "陈某",
  });
  profiles.registerStore({
    storeId: "stall_1",
    brandId: "brand_mx",
    name: "闽地小吃·东街口档口",
    address: "福州市东街口 12 号",
  });
  profiles.registerStore({
    storeId: "stall_2",
    brandId: "brand_mx",
    name: "闽地小吃·三坊七巷档口",
    address: "福州市三坊七巷 8 号",
  });
  profiles.registerCategory({ categoryId: "cat_noodle", brandId: "brand_mx", name: "拌面" });
  profiles.registerCategory({ categoryId: "cat_wonton", brandId: "brand_mx", name: "扁肉" });
  profiles.registerCategory({ categoryId: "cat_guobian", brandId: "brand_mx", name: "锅边" });
  profiles.publishStandard({
    standardId: "std_v1",
    brandId: "brand_mx",
    versionNo: "v1.0",
    title: "闽地小吃门店运营与食品安全标准",
    effectiveFrom: "2026-01-01T00:00:00+08:00",
    clauses: [
      { clauseId: "c1", text: "从业人员持有效健康证明" },
      { clauseId: "c2", text: "冷链食材索证索票" },
      { clauseId: "c3", text: "明厨亮灶，公示实际经营者" },
    ],
  });

  licensing.grantLicense({
    licenseId: "lic_root",
    brandId: "brand_mx",
    operatorId: "op_a",
    scope: { stores: ["stall_1", "stall_2"], categories: ["cat_noodle", "cat_wonton"] },
    standardVersionIds: ["std_v1"],
    requiredApprovals: ["brand_office"],
    grantedBy: { id: "u_office", role: "brand_office" },
  });
  licensing.decideApproval("lic_root", {
    role: "brand_office",
    decision: "approved",
    reviewer: { id: "u_office", role: "brand_office" },
  });

  licensing.grantLicense({
    licenseId: "lic_sub_b",
    brandId: "brand_mx",
    operatorId: "op_b",
    scope: { stores: ["stall_1"], categories: ["cat_noodle"] },
    parentLicenseId: "lic_root",
    standardVersionIds: ["std_v1"],
    requiredApprovals: ["brand_office"],
    grantedBy: { id: "u_a", role: "operator" },
  });
  licensing.decideApproval("lic_sub_b", {
    role: "brand_office",
    decision: "approved",
    reviewer: { id: "u_office2", role: "brand_office" },
  });
  // 跨主体转授（op_a → op_b）除品牌办公室外还须上游持有人批准。
  licensing.decideApproval("lic_sub_b", {
    role: "upstream_holder",
    decision: "approved",
    reviewer: { id: "u_a", role: "upstream_holder" },
  });

  return { app, ...app };
}

// 便捷角色
export const roles = Object.freeze({
  inspector: { id: "u_insp1", role: "inspector" },
  inspector2: { id: "u_insp2", role: "inspector" },
  reviewer: { id: "u_rev1", role: "brand_quality_reviewer" },
  reviewer2: { id: "u_rev2", role: "district_regulator" },
  office: { id: "u_office", role: "brand_office" },
  operatorA: { id: "u_a", role: "operator" },
  operatorB: { id: "u_b", role: "operator" },
});

export { createApplication, MutableClock };
