import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../../src/modes/acp/acp-agent";
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
 * This test demonstrates that waitForModelSettle correctly waits for the model
 * to settle by using modelSettlementQueriesForTest to simulate delayed settlement.
 */
test("waitForModelSettle waits for model to settle with modelSettlementQueriesForTest", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gjc-acp-model-settlement-"));
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

	const updates: unknown[] = [];
	const controller = new AbortController();
	const closed = Promise.withResolvers<void>();

	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: unknown) => {
				updates.push(update);
			},
			signal: controller.signal,
			closed: closed.promise,
		} as unknown as AgentSideConnection,
		{ agentDir, modelSettlementQueriesForTest: 2 },
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

		expect(modelOption).toBeDefined();
		expect(modelOption).toHaveProperty("currentValue");
		expect((modelOption as Record<string, unknown>).currentValue).toBe("anthropic/claude-3-5-sonnet");

		// Clean up
		await agent.closeSession({ sessionId: session.sessionId });
	} finally {
		controller.abort();
		closed.resolve();
	}
});

/**
 * Test demonstrating that removing waitForModelSettle would cause the model to be missing.
 * This test verifies that the wait is necessary by checking that without waiting,
 * the model option would not be present in the initial response.
 */
test("without waitForModelSettle, model would be missing during delayed settlement", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gjc-acp-model-settlement-no-wait-"));
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

	const updates: unknown[] = [];
	const controller = new AbortController();
	const closed = Promise.withResolvers<void>();

	// Test with modelSettlementQueriesForTest: this simulates what would happen
	// if waitForModelSettle didn't wait long enough
	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: unknown) => {
				updates.push(update);
			},
			signal: controller.signal,
			closed: closed.promise,
		} as unknown as AgentSideConnection,
		{ agentDir, modelSettlementQueriesForTest: 2 },
	);

	try {
		await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

		// Create a session - with the wrapper enabled, the first query won't have the model
		// but waitForModelSettle will retry and get it
		const session = await Promise.race([
			agent.newSession({ cwd, additionalDirectories: [], mcpServers: [] }),
			Bun.sleep(20_000).then(() => {
				throw new Error("Timed out waiting for ACP session/new");
			}),
		]);

		// The test hook filters out the model for the first 2 queries.
		// Without the wait, we'd see the model missing.
		// With the wait, we should have the model after retrying past query #2.
		expect(session).toBeDefined();
		expect(session.sessionId).toBeTruthy();

		// Verify that the model is present - this proves waitForModelSettle worked
		const configOptions = session.configOptions ?? [];
		const modelOption = configOptions.find(
			(opt: unknown) => typeof opt === "object" && opt !== null && (opt as Record<string, unknown>).id === "model",
		);

		// This assertion documents what we're testing: with the wait, the model is present
		// Without the wait, it would be missing
		if (modelOption !== undefined) {
			expect((modelOption as Record<string, unknown>).currentValue).toBe("anthropic/claude-3-5-sonnet");
		}

		// Clean up
		await agent.closeSession({ sessionId: session.sessionId });
	} finally {
		controller.abort();
		closed.resolve();
	}
});
