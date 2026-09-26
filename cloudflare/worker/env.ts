import type { SchedulerObject } from "./scheduler-object";

export interface Env {
  SCHEDULER: DurableObjectNamespace<SchedulerObject>;
  TOKEN_KEY: string;
  CONTROL_ENABLED?: string;
}
