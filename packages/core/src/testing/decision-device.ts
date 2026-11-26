import { createHmac } from "node:crypto";
import type { DecisionDevice } from "../settings/device";

/**
 * A device for tests that never touches VaultOre's folder: its key is derived
 * from its id, so two calls with one id are the same device.
 */
export function testDecisionDevice(id = "a".repeat(32), options: { acceptOtherDevices?: boolean } = {}): DecisionDevice {
	return {
		id,
		sign: (text) => createHmac("sha256", `test-key-${id}`).update(text, "utf8").digest("hex"),
		acceptOtherDevices: options.acceptOtherDevices === true,
	};
}
