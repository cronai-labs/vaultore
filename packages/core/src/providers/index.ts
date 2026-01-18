/**
 * @vaultore/core - AI Providers
 *
 * BRICK-007/008/009: AI provider abstraction
 */

import { AIProvider, CompletionRequest, CompletionResponse, PlatformAdapter } from "../types";

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

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI error: ${response.status} ${text}`);
      }

      const data = (await response.json()) as any;
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
      const response = await fetch("https://api.anthropic.com/v1/messages", {
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
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic error: ${response.status} ${text}`);
      }

      const data = (await response.json()) as any;
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
