# Changelog

All notable changes to VaultOre will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-15

### Features

- **obsidian:** Prepare plugin for community marketplace launch
- **runtime:** Add Apple container engine support
- **obsidian:** Adopt current plugin template conventions
- **core:** Emit OKF-conformant frontmatter on outputs and artifacts
- **cli:** Add standalone CLI with headless agent and schedule export
- **release:** Derive semver and changelog from conventional commits

### Bug Fixes

- **obsidian:** Improve plugin quality for marketplace launch
- **obsidian:** Comply with plugin review guidelines and speed up startup
- **cli:** Resolve workflow paths against --vault and surface cell errors
- **cli:** Remove polynomial-backtracking regexes from vault scanning
- **core:** Explain engine selection, bound AI requests, finalise run records
- **core:** Close the gaps a review found in this PR's own changes
- **core:** Preserve edits made while a workflow runs (#51)
- **core:** Remove polynomial backtracking from the parser and scope CI permissions (#50)
- **executor:** Gate {{note:}} on vaultRead and stop rescanning output text (#72)
- **executor:** Enforce vaultRead at the container mount (#74)
- **executor:** Bind permission grants to the note's content (#75)
- **runtime:** Reliable engine detection and hardened cell containers (#86)
- **executor:** Write output notes as OKF v0.2 concepts (#87)
- **providers:** Send requests through the platform and reject a model the provider cannot serve (#88)
- **fixtures:** Make smart-inbox a working canonical example (#89)
- **obsidian:** Scheduled workflows need consent, and API keys come from the selected secret (#90)
- **executor:** Hide the CLI's .vaultore from cells (#97)
- **core:** Default buildNetwork to deny until a cell type uses it (#98)
- **executor:** Apply vault writes on the host, confined to the vault and checked against what the cell read (#127)
- **runtime:** Put the engine's own directory on its PATH (#129)

