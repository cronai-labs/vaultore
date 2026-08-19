/**
 * @vaultore/core - AI Providers
 *
 * BRICK-007/008/009: AI provider abstraction
 */

import { AIProvider, CompletionRequest, CompletionResponse, PlatformAdapter } from "../types";

// =============================================================================
// WIRE FORMATS
// =============================================================================

/** The subset of the OpenAI chat-completions response this module reads. */
interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** The subset of the Anthropic messages response this module reads. */
interface AnthropicResponse {
  content?: Array<{ text?: string }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// =============================================================================
// REQUEST TIMEOUT
// =============================================================================

/**
 * Provider calls are unbounded by default: `runtime.timeout` in frontmatter
 * bounds container cells only, so a hung request would stall a workflow for as
 * long as the network took to give up. A scheduled run was observed failing
 * with a bare "Failed to fetch" after 15.5 minutes.
 */
export const DEFAULT_AI_TIMEOUT_SECONDS = 120;

function timeoutMsFor(platform: PlatformAdapter): number {
  const configured = platform.getSetting<number>("vaultore.aiTimeoutSeconds");
  const seconds =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_AI_TIMEOUT_SECONDS;
  return seconds * 1000;
}

/**
 * Turn transport failures into something a user can act on. `fetch` rejects
 * with a bare "Failed to fetch" in Obsidian's renderer, which does not
 * distinguish no-network from a blocked origin from a timeout.
 */
function describeRequestFailure(
  err: unknown,
  provider: string,
  model: string,
  startedAt: number,
  timeoutMs: number
): Error {
  const elapsedMs = Date.now() - startedAt;
  const seconds = Math.round(elapsedMs / 100) / 10;

  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new Error(
      `${provider} request for model "${model}" timed out after ${timeoutMs / 1000}s. ` +
        `Raise the "AI request timeout" setting (vaultore.aiTimeoutSeconds) if the model needs longer.`
    );
  }

  const detail = err instanceof Error ? err.message : String(err);
  return new Error(
    `${provider} request for model "${model}" failed after ${seconds}s: ${detail}. ` +
      `Check network access and that the stored API key is valid.`
  );
}

// =============================================================================
// PROVIDER FACTORY
// =============================================================================

export async function createProviderFromSettings(
  platform: PlatformAdapter,
  providerName: string
): Promise<AIProvider> {
  switch (providerName) {
    case "anthropic":
      return createAnthropicProvider(platform);
    case "openai":
    default:
      return createOpenAIProvider(platform);
  }
}

// =============================================================================
// OPENAI
// =============================================================================

export function createOpenAIProvider(platform: PlatformAdapter): AIProvider {
  return {
    name: "openai",
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const apiKey = await platform.getSecret("openai.apiKey");
      if (!apiKey) {
        throw new Error("Missing OpenAI API key");
      }

      const useMaxCompletionTokens = usesMaxCompletionTokens(request.model);
      const supportsTemperature = supportsTemperatureParam(request.model);
      const body: Record<string, unknown> = {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
      };

      if (supportsTemperature && request.temperature !== undefined) {
        body.temperature = request.temperature;
      }

      if (request.maxTokens !== undefined) {
        if (useMaxCompletionTokens) {
          body.max_completion_tokens = request.maxTokens;
        } else {
          body.max_tokens = request.maxTokens;
        }
      }

      const timeoutMs = timeoutMsFor(platform);
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw describeRequestFailure(err, "OpenAI", request.model, startedAt, timeoutMs);
      }

      // Read the body inside the guard too: the abort signal stays attached to
      // the body stream, so a response whose headers arrive and whose body
      // stalls would otherwise reject with the bare error this module exists to
      // replace — and on the !ok path would lose the status code entirely.
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch (err) {
        throw describeRequestFailure(err, "OpenAI", request.model, startedAt, timeoutMs);
      }

      if (!response.ok) {
        throw new Error(`OpenAI error: ${response.status} ${bodyText || "<empty body>"}`);
      }

      const data = JSON.parse(bodyText) as OpenAIResponse;
      const content = data.choices?.[0]?.message?.content ?? "";

      return {
        content,
        model: request.model,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
      };
    },
  };
}

function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("gpt-5")
  );
}

function supportsTemperatureParam(model: string): boolean {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("o1") || normalized.startsWith("o3")) return false;
  if (normalized.startsWith("gpt-5")) return false;
  return true;
}

// =============================================================================
// ANTHROPIC
// =============================================================================

export function createAnthropicProvider(platform: PlatformAdapter): AIProvider {
  return {
    name: "anthropic",
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const apiKey = await platform.getSecret("anthropic.apiKey");
      if (!apiKey) {
        throw new Error("Missing Anthropic API key");
      }

      const maxTokens = request.maxTokens ?? 800;
      const timeoutMs = timeoutMsFor(platform);
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: maxTokens,
            ...(request.temperature !== undefined
              ? { temperature: request.temperature }
              : {}),
            messages: [{ role: "user", content: request.prompt }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw describeRequestFailure(err, "Anthropic", request.model, startedAt, timeoutMs);
      }

      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch (err) {
        throw describeRequestFailure(err, "Anthropic", request.model, startedAt, timeoutMs);
      }

      if (!response.ok) {
        throw new Error(`Anthropic error: ${response.status} ${bodyText || "<empty body>"}`);
      }

      const data = JSON.parse(bodyText) as AnthropicResponse;
      const content = data.content?.[0]?.text ?? "";

      return {
        content,
        model: request.model,
        usage: data.usage
          ? {
              promptTokens: data.usage.input_tokens,
              completionTokens: data.usage.output_tokens,
              totalTokens: data.usage.input_tokens + data.usage.output_tokens,
            }
          : undefined,
      };
    },
  };
}
