import { ControlServiceError, type ControlCapturePort } from "../../src/platforms/linux/shared/control.js";

export { ControlServiceError };

/** Owned fault injection only: creation reports unconfirmed cleanup after bus allocation. */
export class DevControlService {
  static async create(_bus: unknown, _capture: ControlCapturePort): Promise<DevControlService> {
    throw new ControlServiceError("TEARDOWN_FAILED");
  }
  async close(): Promise<void> { throw new ControlServiceError("TEARDOWN_FAILED"); }
}
