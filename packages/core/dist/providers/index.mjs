// src/providers/index.ts
async function createProviderFromSettings(platform, providerName) {
  switch (providerName) {
    case "anthropic":
      return createAnthropicProvider(platform);
    case "openai":
    default:
      return createOpenAIProvider(platform);
  }
}
function createOpenAIProvider(platform) {
  return {
    name: "openai",
    async complete(request) {
      const apiKey = await platform.getSecret("openai.apiKey");
      if (!apiKey) {
        throw new Error("Missing OpenAI API key");
      }
      const useMaxCompletionTokens = usesMaxCompletionTokens(request.model);
      const supportsTemperature = supportsTemperatureParam(request.model);
      const body = {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }]
      };
      if (supportsTemperature && request.temperature !== void 0) {
        body.temperature = request.temperature;
      }
      if (request.maxTokens !== void 0) {
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
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI error: ${response.status} ${text}`);
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      return {
        content,
        model: request.model,
        usage: data.usage ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens
        } : void 0
      };
    }
  };
}
function usesMaxCompletionTokens(model) {
  const normalized = model.toLowerCase();
  return normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("gpt-5");
}
function supportsTemperatureParam(model) {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("o1") || normalized.startsWith("o3")) return false;
  if (normalized.startsWith("gpt-5")) return false;
  return true;
}
function createAnthropicProvider(platform) {
  return {
    name: "anthropic",
    async complete(request) {
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
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: maxTokens,
          ...request.temperature !== void 0 ? { temperature: request.temperature } : {},
          messages: [{ role: "user", content: request.prompt }]
        })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic error: ${response.status} ${text}`);
      }
      const data = await response.json();
      const content = data.content?.[0]?.text ?? "";
      return {
        content,
        model: request.model,
        usage: data.usage ? {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens
        } : void 0
      };
    }
  };
}

export { createAnthropicProvider, createOpenAIProvider, createProviderFromSettings };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map