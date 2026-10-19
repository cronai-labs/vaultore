import type { PlatformRequest, PlatformResponse } from "@vaultore/core";

/**
 * The CLI's transport for AI provider requests. It lives here rather than in
 * core so the plugin bundle carries no `fetch`: the plugin sends through
 * Obsidian's `requestUrl` (#117). The abort signal releases the connection on
 * timeout; core bounds the call as well.
 */
export async function fetchRequest(request: PlatformRequest): Promise<PlatformResponse> {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
		signal: AbortSignal.timeout(request.timeoutMs),
	});
	// Read the body here too: the abort signal stays attached to the body
	// stream, so a body that stalls after the headers arrive is bounded as well.
	return { status: response.status, text: await response.text() };
}
