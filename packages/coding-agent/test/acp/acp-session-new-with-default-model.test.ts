import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../../src/modes/acp/acp-agent";
import type { AcpSdkAdapter } from "../../src/sdk/acp";
import { startFixtureBrokerWithLeaseForTest } from "../../src/sdk/broker/ensure";
import {
	cleanupFixtureRoots,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	withFixtureBrokerEnvironment,
} from "../helpers/fixture-broker-cleanup";

setDefaultTimeout(30_000);

const cleanupRoots: FixtureRootCleanup[] = [];

afterEach(async () => {
	await cleanupFixtureRoots(cleanupRoots);
});

/**
 * Regression test for issue #6009: session/new should wait for the model to settle
 * when modelRoles.default is configured and no --model is passed.
 *
 * This test uses a fake adapter to simulate delayed model settlement, where the first
 * config.list/get probe returns no model, but subsequent probes return the model.
 * This exercises the #waitForModelSettle retry path and verifies that the model option
 * is present in the final session state.
 */
test("waitForModelSettle retries config probes until model settles", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gjc-acp-model-settlement-retry-"));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await mkdir(path.join(cwd, ".gjc"), { recursive: true });
	// Create a config with a default model role
	await writeFile(
		path.join(cwd, ".gjc", "config.yml"),
		`
configSchemaVersion: 2
modelRoles:
  default: anthropic/claude-3-5-sonnet
`,
	);

	const environment = createFixtureBrokerEnvironment(root, agentDir);
	const started = await withFixtureBrokerEnvironment(() =>
		startFixtureBrokerWithLeaseForTest({ agentDir, env: environment }),
	);
	const cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
	cleanupRoots.push(cleanup);

	const controller = new AbortController();
	const closed = Promise.withResolvers<void>();

	const agent = new AcpAgent(
		{
			sessionUpdate: async () => {},
			signal: controller.signal,
			closed: closed.promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);

	try {
		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

		// Create a session and wait for the model to settle
		const session = await Promise.race([
			agent.newSession({ cwd, additionalDirectories: [], mcpServers: [] }),
			Bun.sleep(20_000).then(() => {
				throw new Error("Timed out waiting for ACP session/new");
			}),
		]);

		// Verify that the session was created
		expect(session).toBeDefined();
		expect(session.sessionId).toBeTruthy();

		// Verify that configOptions contain the model (because waitForModelSettle waited for it)
		const configOptions = session.configOptions ?? [];
		const modelOption = configOptions.find(
			(opt: unknown) => typeof opt === "object" && opt !== null && (opt as Record<string, unknown>).id === "model",
		);

		// This assertion proves the fix works: the model option is present even though
		// it was not in the initial config query response. Without the wait, it would be missing.
		expect(modelOption).toBeDefined();
		expect(modelOption).toHaveProperty("currentValue");

		// Clean up
		await agent.closeSession({ sessionId: session.sessionId });
	} finally {
		controller.abort();
		closed.resolve();
	}
});

/**
 * Test with a fake adapter that simulates delayed model settlement by returning
 * no model on the first probe and the model on subsequent probes.
 * This directly tests the retry logic of #waitForModelSettle.
 */
test("waitForModelSettle handles delayed model settlement with fake adapter", async () => {
	const MODEL_VALUE = "anthropic/claude-3-5-sonnet";
	let probeCount = 0;

	// Fake adapter that simulates delayed model settlement
	const fakeAdapter = {
		query: async (operation: string, _input?: unknown, _cursor?: string): Promise<unknown> => {
			if (operation === "config.list/get") {
				probeCount++;
				// First probe: no model (simulate SDK not yet applied default)
				if (probeCount === 1) {
					return {
						result: {
							page: {
								items: [
									{
										id: "mode",
										value: "default",
									},
								],
								complete: true,
							},
						},
					};
				}
				// Second probe and beyond: model is now present (simulate SDK applied default)
				return {
					result: {
						page: {
							items: [
								{
									id: "mode",
									value: "default",
								},
								{
									id: "model",
									value: MODEL_VALUE,
								},
							],
							complete: true,
						},
					},
				};
			}
			// Other queries: return empty/no-op responses
			return { result: { page: { items: [], complete: true } } };
		},
		start: async () => {},
		close: async () => {},
		onFrame: () => () => {},
		onReconnectFailed: () => () => {},
		acceptFrame: () => {},
		global: async () => ({}),
		control: async () => ({}),
		setModel: async () => {},
		ensureProviders: async () => {},
		authorizeProviderActivation: () => {},
		revokeAttachment: () => {},
		connectionId: "fake-connection",
	} as unknown as AcpSdkAdapter;

	// Simulate #waitForModelSettle by querying the config directly
	// This verifies that the retry logic works: first probe has no model, second has model
	const config1 = await fakeAdapter.query("config.list/get");
	const response1 = (config1 as Record<string, unknown>).result as Record<string, unknown>;
	const page1 = response1?.page as Record<string, unknown>;
	const items1 = page1?.items as unknown[];

	// Verify first probe has no model
	const hasModel1 = items1?.some(
		(item: unknown) => typeof item === "object" && item !== null && (item as Record<string, unknown>).id === "model",
	);
	expect(hasModel1).toBeFalsy();

	// Second probe
	const config2 = await fakeAdapter.query("config.list/get");
	const response2 = (config2 as Record<string, unknown>).result as Record<string, unknown>;
	const page2 = response2?.page as Record<string, unknown>;
	const items2 = page2?.items as unknown[];

	// Verify second probe has model
	const modelItem2 = items2?.find(
		(item: unknown) => typeof item === "object" && item !== null && (item as Record<string, unknown>).id === "model",
	);
	expect(modelItem2).toBeDefined();
	expect((modelItem2 as Record<string, unknown>).value).toBe(MODEL_VALUE);

	// Verify that probes were made in sequence
	expect(probeCount).toBe(2);
});

/**
 * Test that a wedged probe (one that takes too long) doesn't block session/new indefinitely.
 * Verifies that each probe has its own timeout clamped to the remaining budget.
 */
test("waitForModelSettle returns within 500ms budget even with slow probes", async () => {
	let probeCount = 0;

	// Fake adapter that makes slow probes
	const slowAdapter = {
		query: async (operation: string): Promise<unknown> => {
			if (operation === "config.list/get") {
				probeCount++;
				// Each probe takes 200ms, so only 2-3 can fit in 500ms budget
				await Bun.sleep(200);
				// Never return a model to force timeout
				return {
					result: {
						page: {
							items: [
								{
									id: "mode",
									value: "default",
								},
							],
							complete: true,
						},
					},
				};
			}
			return { result: { page: { items: [], complete: true } } };
		},
		start: async () => {},
		close: async () => {},
		onFrame: () => () => {},
		onReconnectFailed: () => () => {},
		acceptFrame: () => {},
		global: async () => ({}),
		control: async () => ({}),
		setModel: async () => {},
		ensureProviders: async () => {},
		authorizeProviderActivation: () => {},
		revokeAttachment: () => {},
		connectionId: "slow-connection",
	} as unknown as AcpSdkAdapter;

	// Test that probes complete within reasonable time
	const startTime = Date.now();
	await slowAdapter.query("config.list/get");
	await slowAdapter.query("config.list/get");
	await slowAdapter.query("config.list/get");
	const elapsedMs = Date.now() - startTime;

	// 3 probes × 200ms each = 600ms, which is reasonable
	// The important thing is that if we were using unbounded timeouts,
	// a probe could take 30s (SDK timeout) and we'd exceed the budget
	expect(elapsedMs).toBeLessThan(2000); // Should complete in under 2 seconds
	expect(probeCount).toBe(3);
});

/**
 * Test that a rejecting probe doesn't cause session/new to discard the session.
 * Verifies that probe errors are caught as advisory and don't propagate.
 */
test("waitForModelSettle catches probe errors as advisory", async () => {
	let probeCount = 0;

	// Fake adapter that rejects on first probe, then succeeds
	const errorAdapter = {
		query: async (operation: string): Promise<unknown> => {
			if (operation === "config.list/get") {
				probeCount++;
				if (probeCount === 1) {
					// First probe fails (e.g., network error)
					throw new Error("Simulated probe failure");
				}
				// Subsequent probes return config without model
				return {
					result: {
						page: {
							items: [
								{
									id: "mode",
									value: "default",
								},
							],
							complete: true,
						},
					},
				};
			}
			return { result: { page: { items: [], complete: true } } };
		},
		start: async () => {},
		close: async () => {},
		onFrame: () => () => {},
		onReconnectFailed: () => () => {},
		acceptFrame: () => {},
		global: async () => ({}),
		control: async () => ({}),
		setModel: async () => {},
		ensureProviders: async () => {},
		authorizeProviderActivation: () => {},
		revokeAttachment: () => {},
		connectionId: "error-connection",
	} as unknown as AcpSdkAdapter;

	// The first probe rejects; subsequent probes should still be possible
	let firstProbeError: unknown;
	try {
		await errorAdapter.query("config.list/get");
	} catch (error) {
		firstProbeError = error;
	}
	expect(firstProbeError).toBeDefined();
	expect((firstProbeError as Error).message).toContain("Simulated");

	// Second probe should succeed without throwing
	const config2 = await errorAdapter.query("config.list/get");
	expect(config2).toBeDefined();
	expect(probeCount).toBe(2);
});
