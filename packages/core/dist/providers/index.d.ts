import { o as PlatformAdapter, A as AIProvider } from '../index-DIxOf9vK.js';
import 'zod';

/**
 * @vaultore/core - AI Providers
 *
 * BRICK-007/008/009: AI provider abstraction
 */

declare function createProviderFromSettings(platform: PlatformAdapter, providerName: string): Promise<AIProvider>;
declare function createOpenAIProvider(platform: PlatformAdapter): AIProvider;
declare function createAnthropicProvider(platform: PlatformAdapter): AIProvider;

export { createAnthropicProvider, createOpenAIProvider, createProviderFromSettings };
