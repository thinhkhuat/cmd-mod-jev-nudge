// jev-nudge client — one POST /systemone to the configured route. The default route is jevd,
// the owner's warm local relay (`http://127.0.0.1:4377`), which holds the provider keys and
// answers in a fraction of a cold direct call, so it gets no Authorization header and a
// `X-Jevd-Budget` matching our own timeout (jevd stops trying rungs once we'd give up). A
// non-loopback base URL is a direct provider route instead: it sends `Bearer <key>` and only
// content-type. A direct fetch rather than spawning `cmd -p … -m typesafe/jev`: the stop
// hook sits between "model finished" and "prompt comes back", and a second CLI process would
// add its boot time, load this very mod again, and hand back text to parse instead of JSON.

import type {
	JevConfig,
	NudgeAnswers,
	NudgeQuestions,
	NudgeState,
} from './protocol.js';
import {jevResponseSchema, SYSTEM_ONE_PATH} from './protocol.js';

export type JevFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AskJevParams {
	readonly config: JevConfig;
	readonly state: NudgeState;
	readonly questions: NudgeQuestions;
	readonly fetch: JevFetch;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export interface AskJevResult {
	readonly answers: NudgeAnswers;
	readonly model: string | undefined;
}

/** Ask Jev the nudge questions. Throws on transport, HTTP, or shape failures. */
export async function askJev(params: AskJevParams): Promise<AskJevResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), params.timeoutMs);
	timer.unref?.();
	const abort = (): void => controller.abort();
	params.signal?.addEventListener('abort', abort, {once: true});
	try {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		// jevd holds its own provider keys; passing one through would only clobber a rung it
		// has no key for. Direct routes keep the upstream auth.
		if (params.config.apiKey && !params.config.jevd)
			headers.Authorization = `Bearer ${params.config.apiKey}`;
		const body: Record<string, unknown> = {
			state: params.state,
			questions: params.questions,
		};
		// No model field on jevd: absent, jevd's ladder picks the provider.
		if (params.config.model) body.model = params.config.model;
		const response = await params.fetch(
			`${params.config.baseUrl}${SYSTEM_ONE_PATH}`,
			{
				method: 'POST',
				headers:
					params.config.jevd && params.timeoutMs > 0
						? {
								...headers,
								'X-Jevd-Budget': `${Math.round(params.timeoutMs / 1000)}`,
							}
						: headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(
				`jev ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
			);
		}
		const parsed = jevResponseSchema.safeParse(await response.json());
		if (!parsed.success) {
			throw new Error(
				`jev returned an unexpected shape: ${parsed.error.message}`,
			);
		}
		return {answers: parsed.data.answers, model: parsed.data.model};
	} finally {
		clearTimeout(timer);
		params.signal?.removeEventListener('abort', abort);
	}
}
