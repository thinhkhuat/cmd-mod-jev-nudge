// jev-nudge mod tests — the wiring: live on the loopback jevd route without any key, direct
// routes keyed as upstream, the request each engine sends, the continue the hook returns,
// the per-run bookkeeping, and that Jev failures never change a stop.

import {describe, expect, it} from 'vitest';
import type {JevFetch} from '../client.js';
import {createJevNudgeMod} from '../index.js';
import {
	COMMAND_CODE_BASE_URL,
	NUDGE_REASON,
	SYSTEM_ONE_PATH,
} from '../protocol.js';
import type {
	AgentState,
	ModApi,
	ModFlagDefinition,
	ModHooks,
} from '../types.js';

interface FakeHost {
	readonly cmd: ModApi;
	readonly hooks: ModHooks[];
	readonly flags: Map<string, ModFlagDefinition>;
	readonly flagValues: Map<string, string>;
	readonly notices: string[];
}

function fakeCmd(): FakeHost {
	const hooks: ModHooks[] = [];
	const flags = new Map<string, ModFlagDefinition>();
	const flagValues = new Map<string, string>();
	const notices: string[] = [];
	const noop = {dispose: (): void => undefined};
	const cmd = {
		name: 'jev-nudge',
		hooks: (registered: ModHooks) => {
			hooks.push(registered);
			return noop;
		},
		addFlag: (name: string, definition: ModFlagDefinition) => {
			flags.set(name, definition);
			return noop;
		},
		getFlag: (name: string) => {
			const value = flagValues.get(name);
			const definition = flags.get(name);
			if (value !== undefined)
				return definition?.type === 'boolean' ? value === 'true' : value;
			return definition?.default;
		},
		ui: {
			notify: (message: string, level?: string): void => {
				notices.push(level === 'warning' ? `warning: ${message}` : message);
			},
		},
	} as unknown as ModApi;
	return {cmd, hooks, flags, flagValues, notices};
}

interface Captured {
	readonly requests: {url: string; init: RequestInit}[];
}

function fakeFetch(respond: (call: number) => unknown): {
	readonly fetch: JevFetch;
	readonly captured: Captured;
} {
	const captured: Captured = {requests: []};
	const fetch: JevFetch = async (url, init) => {
		captured.requests.push({url, init});
		const body = respond(captured.requests.length);
		if (body instanceof Error) throw body;
		if (typeof body === 'number') return new Response('nope', {status: body});
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: {'content-type': 'application/json'},
		});
	};
	return {fetch, captured};
}

const answers = (nudge: number, waiting = 0.1, progress?: number): unknown => ({
	model: 'typesafe/jev',
	answers: {
		nudge: {type: 'noul', noul: nudge},
		waiting: {type: 'noul', noul: waiting},
		...(progress === undefined
			? {}
			: {progress: {type: 'noul', noul: progress}}),
	},
	usage: {input_tokens: 10, output_tokens: 3},
});

// Tests never read the real ~/.commandcode/auth.json.
const noStoredKey = (): undefined => undefined;

const state: AgentState = {
	sessionId: 's-1',
	messages: [
		{
			role: 'user',
			content: [{type: 'text', text: 'fix the flaky test and add a changeset'}],
		},
		{role: 'assistant', content: [{type: 'text', text: 'Fixed the test.'}]},
	],
	interrupted: false,
	modState: {},
};

async function stop(
	host: FakeHost,
	params: {
		turnNumber?: number;
		text?: string;
		stopReason?: 'end_turn' | 'max_tokens';
	} = {},
): Promise<{continue?: boolean; reason?: string} | undefined> {
	const hook = host.hooks[0]?.onStop;
	if (!hook) throw new Error('no onStop registered');
	return hook({
		state,
		stopReason: params.stopReason ?? 'end_turn',
		turnNumber: params.turnNumber ?? 2,
		lastAssistantText: params.text ?? 'Fixed the test.',
	});
}

describe('jev-nudge mod', () => {
	it('registers its flags and goes live without a key — jevd holds the keys', () => {
		const host = fakeCmd();
		createJevNudgeMod({
			env: {},
			storedKey: noStoredKey,
			fetch: fakeFetch(() => answers(1)).fetch,
		})(host.cmd);
		expect([...host.flags.keys()]).toEqual([
			'jev-nudge-threshold',
			'jev-nudge-max',
			'jev-nudge-base-url',
			'jev-nudge-model',
			'jev-nudge-verbose',
		]);
		expect(host.hooks).toHaveLength(1);
		expect(host.notices).toEqual([]);
	});

	it('shows declined stops only with jev-nudge-verbose', async () => {
		const quiet = fakeCmd();
		createJevNudgeMod({
			env: {CMD_API_KEY: 'ck'},
			storedKey: noStoredKey,
			fetch: fakeFetch(() => answers(0.2)).fetch,
		})(quiet.cmd);
		await stop(quiet);
		expect(quiet.notices).toEqual([]);

		const loud = fakeCmd();
		loud.flagValues.set('jev-nudge-verbose', 'true');
		createJevNudgeMod({
			env: {CMD_API_KEY: 'ck'},
			storedKey: noStoredKey,
			fetch: fakeFetch(() => answers(0.2)).fetch,
		})(loud.cmd);
		await stop(loud);
		expect(loud.notices).toEqual([
			'jev-nudge: turn 2, no nudge (below threshold (20% < 50%))',
		]);
	});

	it('posts to jevd with no auth, no model pin, and a part-budget header, and continues on a confident yes', async () => {
		const host = fakeCmd();
		const {fetch, captured} = fakeFetch(() => answers(0.85));
		createJevNudgeMod({
			env: {CMD_API_KEY: 'env-key'},
			storedKey: () => 'stored-key',
			fetch,
		})(host.cmd);

		const result = await stop(host);

		expect(result).toEqual({continue: true, reason: NUDGE_REASON});
		const request = captured.requests[0];
		expect(request?.url).toBe(`http://127.0.0.1:4377${SYSTEM_ONE_PATH}`);
		expect(request?.init.method).toBe('POST');
		// jevd forwards its own keys; ours would only clobber a rung it has one for, and the
		// budget header tells it to stop trying rungs once this hook would give up.
		const headers = new Headers(request?.init.headers);
		expect(headers.get('authorization')).toBeNull();
		expect(headers.get('x-jevd-budget')).toBe('8');
		const body = JSON.parse(String(request?.init.body)) as {
			model?: string;
			state: {user_requests: string[]; latest_assistant_message: string};
			questions: Record<string, {type: string}>;
		};
		// No model field: absent, jevd's ladder picks the provider per call.
		expect('model' in body).toBe(false);
		expect(body.state.user_requests).toEqual([
			'fix the flaky test and add a changeset',
		]);
		expect(body.state.latest_assistant_message).toBe('Fixed the test.');
		expect(Object.keys(body.questions)).toEqual(['nudge', 'waiting']);
		expect(body.questions.nudge?.type).toBe('noul');
		// No cap by default, so the row counts without a denominator.
		expect(host.notices[0]).toContain('jev nudge 1:');
	});

	it('pins the model on jevd when the flag is set', async () => {
		const host = fakeCmd();
		host.flagValues.set('jev-nudge-model', 'typesafe/jev');
		const {fetch, captured} = fakeFetch(() => answers(0.9));
		createJevNudgeMod({env: {}, storedKey: noStoredKey, fetch})(host.cmd);
		expect(await stop(host)).toMatchObject({continue: true});
		expect(JSON.parse(String(captured.requests[0]?.init.body)).model).toBe(
			'typesafe/jev',
		);
	});

	it('auths a direct route with the env key over the stored login, as upstream did', async () => {
		const host = fakeCmd();
		host.flagValues.set('jev-nudge-base-url', COMMAND_CODE_BASE_URL);
		const {fetch, captured} = fakeFetch(() => answers(0.9));
		createJevNudgeMod({
			env: {CMD_API_KEY: 'env-key'},
			storedKey: () => 'stored-key',
			fetch,
		})(host.cmd);

		expect(await stop(host)).toMatchObject({continue: true});
		const request = captured.requests[0];
		expect(request?.url).toBe(`${COMMAND_CODE_BASE_URL}${SYSTEM_ONE_PATH}`);
		const headers = new Headers(request?.init.headers);
		expect(headers.get('authorization')).toBe('Bearer env-key');
		expect(headers.get('x-jevd-budget')).toBeNull();
		expect(JSON.parse(String(request?.init.body)).model).toBe('typesafe/jev');
	});

	it('uses the key `cmd login` saved when no env key is set on a direct route', async () => {
		const host = fakeCmd();
		host.flagValues.set('jev-nudge-base-url', COMMAND_CODE_BASE_URL);
		const {fetch, captured} = fakeFetch(() => answers(0.9));
		createJevNudgeMod({env: {}, storedKey: () => 'stored-key', fetch})(
			host.cmd,
		);
		expect(await stop(host)).toMatchObject({continue: true});
		expect(
			new Headers(captured.requests[0]?.init.headers).get('authorization'),
		).toBe('Bearer stored-key');
	});

	it('says once, and goes dark, on a direct route with no key', async () => {
		const host = fakeCmd();
		host.flagValues.set('jev-nudge-base-url', COMMAND_CODE_BASE_URL);
		const {fetch, captured} = fakeFetch(() => answers(1));
		createJevNudgeMod({env: {}, storedKey: noStoredKey, fetch})(host.cmd);
		expect(await stop(host)).toBeUndefined();
		await stop(host);
		expect(captured.requests).toEqual([]);
		expect(host.notices).toHaveLength(1);
		expect(host.notices[0]).toMatch(/^warning: jev-nudge: no Command Code key/);
	});

	it('lets the run stop when Jev says no', async () => {
		const host = fakeCmd();
		createJevNudgeMod({
			env: {CMD_API_KEY: 'ck'},
			storedKey: noStoredKey,
			fetch: fakeFetch(() => answers(0.2)).fetch,
		})(host.cmd);
		expect(await stop(host)).toBeUndefined();
		expect(host.notices).toEqual([]);
	});

	it('only judges natural end_turn stops', async () => {
		const host = fakeCmd();
		const {fetch, captured} = fakeFetch(() => answers(1));
		createJevNudgeMod({
			env: {CMD_API_KEY: 'ck'},
			storedKey: noStoredKey,
			fetch,
		})(host.cmd);
		expect(await stop(host, {stopReason: 'max_tokens'})).toBeUndefined();
		expect(captured.requests).toEqual([]);
	});

	it('never changes the stop when Jev fails, times out, or answers nonsense, and warns', async () => {
		for (const failure of [new Error('boom'), 503, {answers: {}}]) {
			const host = fakeCmd();
			createJevNudgeMod({
				env: {CMD_API_KEY: 'ck'},
				storedKey: noStoredKey,
				fetch: fakeFetch(() => failure).fetch,
			})(host.cmd);
			expect(await stop(host)).toBeUndefined();
			expect(host.notices).toHaveLength(1);
			expect(host.notices[0]).toMatch(/^warning: jev-nudge: Jev call failed/);
		}
	});

	it('remembers earlier nudges, asks the progress guard, and honors the cap', async () => {
		const host = fakeCmd();
		host.flagValues.set('jev-nudge-max', '2');
		const {fetch, captured} = fakeFetch(() => answers(0.9, 0.1, 0.9));
		createJevNudgeMod({
			env: {CMD_API_KEY: 'ck'},
			storedKey: noStoredKey,
			fetch,
		})(host.cmd);
		const hooks = host.hooks[0];
		if (!hooks?.afterToolCall || !hooks.onTurnStart)
			throw new Error('hooks missing');

		await hooks.onTurnStart({state, turnNumber: 1});
		expect(await stop(host, {turnNumber: 1, text: 'Half done.'})).toMatchObject(
			{continue: true},
		);
		await hooks.afterToolCall({
			state,
			toolCallId: 't1',
			toolName: 'edit_file',
			input: {},
			result: [],
			isError: false,
		});
		expect(await stop(host, {turnNumber: 2, text: 'Now done.'})).toMatchObject({
			continue: true,
		});

		const second = JSON.parse(String(captured.requests[1]?.init.body)) as {
			state: {
				previous_nudges: {assistant_text_at_nudge: string}[];
				latest_assistant_message: string;
			};
			questions: Record<string, unknown>;
		};
		// The nudge remembers the reply it fired on ('Half done.'), not the one this stop is
		// about ('Now done.'). Storing the latter made the progress guard compare a message
		// against itself and veto every nudge after the first.
		expect(second.state.previous_nudges).toEqual([
			{
				turn_number: 1,
				tool_calls_after: 1,
				assistant_text_at_nudge: 'Half done.',
			},
		]);
		expect(second.state.latest_assistant_message).toBe('Now done.');
		expect(second.state.previous_nudges[0]?.assistant_text_at_nudge).not.toBe(
			second.state.latest_assistant_message,
		);
		expect(Object.keys(second.questions)).toContain('progress');

		// Cap reached: no third request, the run stops.
		expect(await stop(host, {turnNumber: 3})).toBeUndefined();
		expect(captured.requests).toHaveLength(2);

		// A new run starts the count over.
		await hooks.onTurnStart({state, turnNumber: 1});
		expect(await stop(host, {turnNumber: 1})).toMatchObject({
			continue: true,
		});
	});

	it('honors base URL, model, and threshold flags', async () => {
		const host = fakeCmd();
		host.flagValues.set('jev-nudge-base-url', 'https://proxy.example/');
		host.flagValues.set('jev-nudge-model', 'jev-2');
		host.flagValues.set('jev-nudge-threshold', '0.95');
		const {fetch, captured} = fakeFetch(() => answers(0.9));
		createJevNudgeMod({
			env: {CMD_API_KEY: 'ck'},
			storedKey: noStoredKey,
			fetch,
		})(host.cmd);

		expect(await stop(host)).toBeUndefined();
		expect(captured.requests[0]?.url).toBe(
			`https://proxy.example${SYSTEM_ONE_PATH}`,
		);
		expect(JSON.parse(String(captured.requests[0]?.init.body)).model).toBe(
			'jev-2',
		);
	});
});
