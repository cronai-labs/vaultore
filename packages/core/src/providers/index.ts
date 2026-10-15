/**
 * @vaultore/core - AI Providers
 *
 * BRICK-007/008/009: AI provider abstraction
 */

import {
  AIProvider,
  CompletionRequest,
  CompletionResponse,
  PlatformAdapter,
  PlatformRequest,
  PlatformResponse,
} from "../types";

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
 * The transport for adapters without a `request` capability (the CLI passes
 * this as its own). The abort signal releases the connection on timeout.
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

/**
 * Send through the adapter when it can, and bound the call in core: Obsidian's
 * `requestUrl` takes no abort signal, and an adapter that ignored `timeoutMs`
 * would otherwise stall the workflow again.
 */
async function send(
  platform: PlatformAdapter,
  request: PlatformRequest,
  provider: string,
  model: string
): Promise<PlatformResponse> {
  const startedAt = Date.now();
  const transport = platform.request
    ? (req: PlatformRequest) => platform.request!(req)
    : fetchRequest;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Request exceeded ${request.timeoutMs}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, request.timeoutMs);
  });
  try {
    return await Promise.race([transport(request), deadline]);
  } catch (err) {
    throw describeRequestFailure(err, provider, model, startedAt, request.timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
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

export const AI_PROVIDERS = ["openai", "anthropic"] as const;
export type AIProviderName = (typeof AI_PROVIDERS)[number];

export const DEFAULT_PROVIDER: AIProviderName = "openai";

/**
 * The model an `ore:ai` cell uses when neither the cell (`model=`) nor the
 * settings (`defaultModel`) name one. The one place these are defined: the
 * plugin's settings defaults and the CLI both come through here.
 */
export const DEFAULT_MODELS: Readonly<Record<AIProviderName, string>> = {
  openai: "gpt-5-mini",
  anthropic: "claude-haiku-4-5",
};

const PROVIDER_LABELS: Record<AIProviderName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/** A missing setting means the default provider; an unknown one is an error. */
export function resolveProviderName(value: string | undefined): AIProviderName {
  if (value === undefined) return DEFAULT_PROVIDER;
  if ((AI_PROVIDERS as readonly string[]).includes(value)) {
    return value as AIProviderName;
  }
  throw new Error(
    `Unknown AI provider "${value}". Set defaultProvider to one of: ${AI_PROVIDERS.join(", ")}.`
  );
}

/** The provider a model id clearly belongs to, if any. */
function ownerOf(model: string): AIProviderName | undefined {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("claude-")) return "anthropic";
  if (/^(gpt-|o1|o3|o4)/.test(normalized)) return "openai";
  return undefined;
}

/**
 * The provider comes from settings, never from the model (#78): a Claude
 * model sent to OpenAI used to come back as a provider 4xx. Fail before the
 * request instead, and say how to fix it; the cell is not re-routed.
 */
export function assertModelMatchesProvider(provider: AIProviderName, model: string): void {
  const owner = ownerOf(model);
  if (!owner || owner === provider) return;
  const ownerLabel = PROVIDER_LABELS[owner];
  throw new Error(
    `Model "${model}" is an ${ownerLabel} model, but the configured provider is ` +
      `${PROVIDER_LABELS[provider]}. VaultOre does not switch providers per cell: set ` +
      `the default provider to ${ownerLabel} (plugin: Settings → VaultOre → Default ` +
      `provider; CLI: "defaultProvider": "${owner}" in .vaultore/config.json), or use ` +
      `a ${PROVIDER_LABELS[provider]} model (model= on the cell, or the default model ` +
      `setting).`
  );
}

export async function createProviderFromSettings(
  platform: PlatformAdapter,
  providerName: AIProviderName
): Promise<AIProvider> {
  switch (providerName) {
    case "anthropic":
      return createAnthropicProvider(platform);
    case "openai":
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

      const response = await send(
        platform,
        {
          url: "https://api.openai.com/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          timeoutMs: timeoutMsFor(platform),
        },
        "OpenAI",
        request.model
      );
      const bodyText = response.text;

      if (!isSuccess(response.status)) {
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
      const response = await send(
        platform,
        {
          url: "https://api.anthropic.com/v1/messages",
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
          timeoutMs: timeoutMsFor(platform),
        },
        "Anthropic",
        request.model
      );
      const bodyText = response.text;

      if (!isSuccess(response.status)) {
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
