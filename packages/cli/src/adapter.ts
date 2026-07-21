/**
 * @vaultore/cli - Node platform adapter
 *
 * Implements the editor-agnostic PlatformAdapter against the plain file
 * system so workflows run headless: CI jobs, cron daemons, CronAI
 * infrastructure, or any terminal — no Obsidian required.
 *
 * Conventions:
 * - Settings live in `<vault>/.vaultore/config.json` (flat keys mirroring
 *   the plugin's settings: defaultProvider, defaultModel, runtimeEngine,
 *   outputRoot, permissionDecisions, ...)
 * - Secrets come from environment variables, never from files:
 *   `openai.apiKey`    → VAULTORE_OPENAI_APIKEY (fallback OPENAI_API_KEY)
 *   `anthropic.apiKey` → VAULTORE_ANTHROPIC_APIKEY (fallback ANTHROPIC_API_KEY)
 * - Permission prompts are non-interactive: grants require an explicit
 *   `--yes` (fail closed otherwise), and decisions persist to config.
 */

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PlatformAdapter } from "@vaultore/core";

const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules"]);

const SECRET_ENV_FALLBACKS: Record<string, string[]> = {
	"openai.apiKey": ["VAULTORE_OPENAI_APIKEY", "OPENAI_API_KEY"],
	"anthropic.apiKey": ["VAULTORE_ANTHROPIC_APIKEY", "ANTHROPIC_API_KEY"],
};

export interface NodeAdapterOptions {
	vaultRoot: string;
	/** Grant "ask" permissions non-interactively. Defaults to false (deny). */
	assumeYes?: boolean;
	/** Override settings without touching the config file (highest precedence). */
	settingsOverride?: Record<string, unknown>;
	/** Quiet mode suppresses info/debug logging. */
	quiet?: boolean;
}

export class NodeAdapter implements PlatformAdapter {
	readonly platform = "cli" as const;
	private readonly vaultRoot: string;
	private readonly assumeYes: boolean;
	private readonly overrides: Record<string, unknown>;
	private readonly quiet: boolean;
	private config: Record<string, unknown>;

	constructor(options: NodeAdapterOptions) {
		this.vaultRoot = resolve(options.vaultRoot);
		this.assumeYes = options.assumeYes ?? false;
		this.overrides = options.settingsOverride ?? {};
		this.quiet = options.quiet ?? false;
		this.config = this.loadConfig();
	}

	// ── File system ───────────────────────────────────────────────────────

	async readFile(path: string): Promise<string> {
		return fs.readFile(this.absolute(path), "utf8");
	}

	async writeFile(path: string, content: string): Promise<void> {
		const abs = this.absolute(path);
		await fs.mkdir(dirname(abs), { recursive: true });
		await fs.writeFile(abs, content, "utf8");
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.access(this.absolute(path));
			return true;
		} catch {
			return false;
		}
	}

	async mkdirp(path: string): Promise<void> {
		await fs.mkdir(this.absolute(path), { recursive: true });
	}

	async listFiles(directory: string, pattern?: string): Promise<string[]> {
		const base = this.absolute(directory);
		const found: string[] = [];
		await this.walk(base, found);
		return found
			.map((abs) => relative(this.vaultRoot, abs).split(sep).join("/"))
			.filter((p) => (pattern ? p.includes(pattern) : true));
	}

	async readRaw(path: string): Promise<string> {
		// Raw reads may target container paths like /proc — pass through as-is.
		return fs.readFile(isAbsolute(path) ? path : this.absolute(path), "utf8");
	}

	async getVaultRoot(): Promise<string> {
		return this.vaultRoot;
	}

	// ── Settings ──────────────────────────────────────────────────────────

	getSetting<T>(key: string): T | undefined {
		const short = key.startsWith("vaultore.") ? key.slice("vaultore.".length) : key;
		if (short in this.overrides) return this.overrides[short] as T;
		return this.config[short] as T | undefined;
	}

	async setSetting<T>(key: string, value: T): Promise<void> {
		const short = key.startsWith("vaultore.") ? key.slice("vaultore.".length) : key;
		this.config[short] = value;
		this.saveConfig();
	}

	// ── Secrets (environment only) ────────────────────────────────────────

	async getSecret(key: string): Promise<string | undefined> {
		for (const envName of this.envNamesFor(key)) {
			const value = process.env[envName];
			if (value) return value;
		}
		return undefined;
	}

	async setSecret(key: string): Promise<void> {
		throw new Error(
			`Secrets are environment-managed in the CLI. Set ${this.envNamesFor(key)[0]} instead.`
		);
	}

	async deleteSecret(key: string): Promise<void> {
		throw new Error(
			`Secrets are environment-managed in the CLI. Unset ${this.envNamesFor(key)[0]} instead.`
		);
	}

	// ── UI ────────────────────────────────────────────────────────────────

	showNotification(message: string, type: "info" | "warning" | "error"): void {
		const stream = type === "info" ? process.stdout : process.stderr;
		stream.write(`[vaultore:${type}] ${message}\n`);
	}

	async confirm(message: string): Promise<boolean> {
		if (this.assumeYes) {
			process.stderr.write(`[vaultore] auto-approved (--yes): ${message}\n`);
			return true;
		}
		process.stderr.write(
			`[vaultore] denied (non-interactive, pass --yes to grant): ${message}\n`
		);
		return false;
	}

	log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
		if (this.quiet && (level === "debug" || level === "info")) return;
		const line = data ? `${message} ${JSON.stringify(data)}` : message;
		const stream = level === "debug" || level === "info" ? process.stdout : process.stderr;
		stream.write(`[vaultore:${level}] ${line}\n`);
	}

	// ── Internals ─────────────────────────────────────────────────────────

	private absolute(path: string): string {
		const normalized = path.replace(/^[\\/]+/, "");
		const abs = resolve(this.vaultRoot, normalized);
		const rel = relative(this.vaultRoot, abs);
		if (rel.startsWith("..")) {
			throw new Error(`Path escapes vault root: ${path}`);
		}
		return abs;
	}

	private async walk(dir: string, found: string[]): Promise<void> {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				await this.walk(join(dir, entry.name), found);
			} else if (entry.isFile()) {
				found.push(join(dir, entry.name));
			}
		}
	}

	private envNamesFor(key: string): string[] {
		const known = SECRET_ENV_FALLBACKS[key];
		if (known) return known;
		const generic = `VAULTORE_${key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
		return [generic];
	}

	private configPath(): string {
		return join(this.vaultRoot, ".vaultore", "config.json");
	}

	private loadConfig(): Record<string, unknown> {
		try {
			if (existsSync(this.configPath())) {
				return JSON.parse(readFileSync(this.configPath(), "utf8")) as Record<string, unknown>;
			}
		} catch (err) {
			process.stderr.write(
				`[vaultore:warn] ignoring unreadable config ${this.configPath()}: ${String(err)}\n`
			);
		}
		return {};
	}

	private saveConfig(): void {
		mkdirSync(dirname(this.configPath()), { recursive: true });
		writeFileSync(this.configPath(), JSON.stringify(this.config, null, 2) + "\n", "utf8");
	}
}
