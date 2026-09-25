import { EventStore } from "./domain/event-store.js";
import { ProfileService } from "./services/profiles.js";
import { LicenseService } from "./services/licensing.js";
import { ComplianceService } from "./services/compliance.js";
import { NotificationService } from "./services/notifications.js";
import { OfflineIngestService } from "./services/offline-ingest.js";
import { OversightService } from "./services/oversight.js";

// 可控时钟：测试/离线重放时可显式推进时间，模拟“中断期间到期、恢复后补齐”。
export class MutableClock {
  constructor(initial = "2026-09-25T08:00:00+08:00") {
    this.current = initial;
  }
  now() {
    return this.current;
  }
  set(iso) {
    this.current = iso;
  }
  advance(durationIso) {
    // 简单推进：durationIso 形如 "PT72H"（仅支持小时/分钟）或直接给 ISO 时间。
    if (durationIso.startsWith("P")) {
      const h = /(\d+)H/.exec(durationIso)?.[1];
      const m = /(\d+)M/.exec(durationIso)?.[1];
      const ms = (h ? Number(h) * 3600000 : 0) + (m ? Number(m) * 60000 : 0);
      this.current = new Date(new Date(this.current).getTime() + ms).toISOString();
    } else {
      this.current = durationIso;
    }
    return this.current;
  }
}

// 应用装配：共享同一个只追加事件存储。
export function createApplication({ clock = new MutableClock(), notificationSink = null } = {}) {
  const store = new EventStore();
  const notifications = new NotificationService(store, clock, notificationSink);
  return {
    clock,
    store,
    profiles: new ProfileService(store, clock),
    licensing: new LicenseService(store, clock),
    compliance: new ComplianceService(store, clock, notifications),
    notifications,
    offline: new OfflineIngestService(store, clock),
    oversight: new OversightService(store),
  };
}

export { EventStore } from "./domain/event-store.js";
export * from "./domain/constants.js";
export * from "./domain/errors.js";
export * from "./domain/event-types.js";
export { contentFingerprint, stableStringify } from "./domain/fingerprint.js";
export { Projection } from "./domain/projection.js";
export { validateEvent } from "./validator.js";
