import { createEventStore } from "./events.js";
import { createRegistry, buildRegistryIndex } from "./registry.js";
import { createAuthorizationService, buildLicenseIndex } from "./authorization.js";
import { createComplianceService } from "./compliance.js";
import { createReceiptLog, createDueTaskRunner } from "./sync.js";
import { createOversight } from "./oversight.js";
import { suggestRisk } from "./risk.js";

// 应用装配门面：一个内存事件存储 + 全部领域服务 + 监管穿透视图。
// options.clock 可注入固定时钟，便于测试离线/到期场景。
export function createGovernance(options = {}) {
  const store = createEventStore(options);
  const registryApi = createRegistry(store);
  const auth = createAuthorizationService(store, buildRegistryIndex(store));
  const compliance = createComplianceService(store, buildRegistryIndex(store), auth);
  const receipts = createReceiptLog(store);
  const dueTasks = createDueTaskRunner(store, options);
  const oversight = createOversight(store);

  return {
    store,
    // 建档
    register: {
      brand: (d, actor) => registryApi.registerBrand(d, actorOf(actor)),
      subject: (d, actor) => registryApi.registerSubject(d, actorOf(actor)),
      store: (d, actor) => registryApi.registerStore(d, actorOf(actor)),
      category: (d, actor) => registryApi.registerCategory(d, actorOf(actor)),
      staff: (d, actor) => registryApi.registerStaff(d, actorOf(actor)),
      standard: (d, actor, occurredAt) => registryApi.publishStandard(d, actorOf(actor), occurredAt),
      supersedeStandard: (d, actor, occurredAt) => registryApi.supersedeStandard(d, actorOf(actor), occurredAt),
      changeStallOperator: (d, actor) => registryApi.changeStallOperator(d, actorOf(actor)),
    },
    // 授权
    auth: {
      grantRoot: (d, actor) => auth.grantRootLicense(d, actorOf(actor)),
      requestSublicense: (d, actor) => auth.requestSublicense(d, actorOf(actor)),
      approveSublicense: (d, actor) => auth.approveSublicense(d, actorOf(actor)),
      rejectSublicense: (d, actor) => auth.rejectSublicense(d, actorOf(actor)),
      suspend: (d, actor) => auth.suspendScope(d, actorOf(actor)),
      resume: (d, actor) => auth.resumeFromCase(d, actorOf(actor)),
      revoke: (d, actor) => auth.revokeLicense(d, actorOf(actor)),
      license: (id) => auth.mustLicense(id),
      tryLicense: (id) => buildLicenseIndex(store).license(id),
    },
    // 办案
    cases: {
      complain: (d, actor) => compliance.recordComplaint(d, actorOf(actor, true)),
      inspect: (d, actor) => compliance.recordInspection(d, actorOf(actor)),
      confirmRisk: (d, actor) => compliance.confirmRisk(d, actorOf(actor)),
      decide: (d, actor) => compliance.decideDisposition(d, actorOf(actor)),
      appeal: (d, actor) => compliance.fileAppeal(d, actorOf(actor, true)),
      resolveAppeal: (d, actor) => compliance.resolveAppeal(d, actorOf(actor)),
      submitRemediation: (d, actor) => compliance.submitRemediation(d, actorOf(actor, true)),
      review: (d, actor) => compliance.reviewRemediation(d, actorOf(actor)),
      get: (id) => compliance.mustCase(id),
    },
    sync: {
      upload: (d) => receipts.ingest(d),
      scheduleDue: (d) => dueTasks.schedule(d),
      runDue: (d) => dueTasks.runDue(d ?? {}),
      goOffline: (at) => dueTasks.goOffline(at),
      recover: (at) => dueTasks.recover(at),
    },
    oversight,
    suggestRisk,
    // 读取当前建档快照
    index: () => buildRegistryIndex(store),
    licenses: () => buildLicenseIndex(store),
    rawEvents: () => store.all(),
  };

  // actor 可只传 staffId，这里从建档补全姓名与角色；经营主体侧申诉允许带 subjectId。
  function actorOf(actor, allowSubject = false) {
    if (!actor) return actor;
    if (typeof actor === "string") return buildRegistryIndex(store).resolveActor({ staffId: actor });
    if (actor.subjectId && !actor.staffId && allowSubject) return actor;
    if (actor.staffId && !actor.roles) return buildRegistryIndex(store).resolveActor({ staffId: actor.staffId });
    return actor;
  }
}
