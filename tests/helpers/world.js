import { createGovernance } from "../../src/app.js";

// 构造一个已完成基础建档的世界，供各测试用例在此之上安排授权与办案。
// 建档本身不强制角色（引导数据），业务动作才校验角色。
export function buildWorld(options = {}) {
  const g = createGovernance(options);
  const noActor = null;

  g.register.brand({ brandId: "b1", name: "沙县公用品牌" }, noActor);
  g.register.subject({ subjectId: "s1", name: "老王餐饮管理公司" }, noActor);
  g.register.subject({ subjectId: "s2", name: "老李夫妻档口" }, noActor);
  g.register.subject({ subjectId: "s3", name: "新接手者小陈" }, noActor);
  g.register.store({ storeId: "st1", name: "城西路店", address: "城西路1号", brandId: "b1" }, noActor);
  g.register.store({ storeId: "st2", name: "河东路店", address: "河东路2号", brandId: "b1" }, noActor);
  g.register.category({ categoryId: "cat-noodle", name: "面食类" }, noActor);
  g.register.category({ categoryId: "cat-snack", name: "卤味小吃类" }, noActor);
  g.register.standard(
    {
      standardVersionId: "std-v1",
      brandId: "b1",
      title: "出餐卫生标准",
      versionNo: "v1",
      effectiveFrom: "2026-01-01",
      items: [
        { code: "H1", text: "生熟分开" },
        { code: "H2", text: "冷链温度" },
      ],
    },
    noActor
  );
  g.register.staff({ staffId: "admin", name: "品牌办张主任", roles: ["brand_admin", "supervisor"] }, noActor);
  g.register.staff({ staffId: "insp1", name: "检查员小王", roles: ["inspector"] }, noActor);
  g.register.staff({ staffId: "insp2", name: "检查员小李", roles: ["inspector"] }, noActor);
  g.register.staff({ staffId: "rev1", name: "复核员小赵", roles: ["reviewer"] }, noActor);
  g.register.staff({ staffId: "rev2", name: "复核员小钱", roles: ["reviewer"] }, noActor);
  // 同时具备检查员与复核员角色：用于验证职责分离（同一案件不能自查自复核）。
  g.register.staff({ staffId: "dual", name: "兼职老周", roles: ["inspector", "reviewer"] }, noActor);

  return g;
}

export const T = {
  t0: "2026-02-01T00:00:00Z",
  grant: "2026-02-01T00:00:00Z",
  inspect: "2026-09-21T00:00:00Z",
  decide: "2026-09-21T02:00:00Z",
  review: "2026-09-25T00:00:00Z",
};
