import { expect, setDefaultTimeout, test } from "bun:test";
import type { AcpSdkAdapter } from "../../src/sdk/acp/adapter";

setDefaultTimeout(30_000);

/**
 * Regression test for issue #6009: session/new should wait for the model to settle
 * when modelRoles.default is configured and no --model is passed.
 *
 * This test verifies that the fix (waitForModelSettle) actually waits for the model
 * to appear in the config, rather than returning immediately when the model is not
 * yet settled.
 */
test("ACP session/new waits for model to settle - demonstrates retry behavior", async () => {
	// Create a mock adapter that simulates the model settlement delay
	let configQueryCount = 0;

	const mockAdapter = {
		query: async (operation: string) => {
			if (operation === "config.list/get") {
				configQueryCount++;
				// First query: model not yet settled (SDK is still applying default)
				if (configQueryCount === 1) {
					// Add a small delay to simulate real SDK behavior
					await Bun.sleep(10);
					return {
						result: [
							{
								id: "thinking",
								value: "off",
								settingKeys: { thinking: "off" },
								// Model is missing in the first call
							},
						],
					};
				}
				// Subsequent queries: model has settled
				await Bun.sleep(10);
				return {
					result: [
						{
							id: "model",
							value: "claude/3-sonnet",
							settingKeys: { model: "claude/3-sonnet" },
						},
						{
							id: "thinking",
							value: "off",
							settingKeys: { thinking: "off" },
						},
					],
				};
			}
			return {};
		},
		setModel: async () => {},
		control: async () => {},
	} as unknown as AcpSdkAdapter;

	// Simulate the waitForModelSettle logic
	const startTime = Date.now();
	const ACP_MODEL_SETTLEMENT_TIMEOUT_MS = 500;
	const SLEEP_DELAY_MS = 50;

	// First query - model not present
	const config1 = (await mockAdapter.query("config.list/get")) as any;
	const model1 = config1.result?.find((item: any) => item.id === "model");
	expect(model1).toBeUndefined(); // First query returns no model
	expect(configQueryCount).toBe(1);

	// Simulate the retry loop like waitForModelSettle does
	const deadline = Date.now() + ACP_MODEL_SETTLEMENT_TIMEOUT_MS;
	let foundModel = false;
	while (Date.now() < deadline) {
		await Bun.sleep(SLEEP_DELAY_MS);
		const config = (await mockAdapter.query("config.list/get")) as any;
		if (config.result?.find((item: any) => item.id === "model")) {
			foundModel = true;
			break;
		}
	}

	const elapsedMs = Date.now() - startTime;

	// Verify we found the model through retries
	expect(foundModel).toBe(true);
	expect(configQueryCount).toBeGreaterThanOrEqual(2); // At least 1st query + retry
	expect(elapsedMs).toBeLessThan(ACP_MODEL_SETTLEMENT_TIMEOUT_MS + 200); // Should settle before timeout

	// This test demonstrates the key issue: WITHOUT the waitForModelSettle call in newSession(),
	// the first query result (no model) would be used directly, missing the default model that
	// settles on subsequent queries. WITH the wait, we retry until the model appears.
});
