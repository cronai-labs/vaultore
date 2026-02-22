module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Allow these types (Conventional Commits standard + extras)
    "type-enum": [
      2,
      "always",
      [
        "feat",     // New feature        → minor bump
        "fix",      // Bug fix            → patch bump
        "docs",     // Documentation only → no bump
        "style",    // Formatting only    → no bump
        "refactor", // Code restructuring → no bump
        "perf",     // Performance        → patch bump
        "test",     // Tests only         → no bump
        "build",    // Build system       → no bump
        "ci",       // CI config          → no bump
        "chore",    // Maintenance        → no bump
        "revert",   // Revert commit      → patch bump
      ],
    ],
    // Scope is optional but encouraged
    "scope-enum": [
      1,
      "always",
      [
        "core",       // @vaultore/core changes
        "obsidian",   // Obsidian plugin changes
        "parser",     // Workflow parser
        "executor",   // Cell execution engine
        "runtime",    // Container runtime
        "scheduler",  // Cron scheduling
        "providers",  // AI providers
        "vault",      // Vault API
        "deps",       // Dependency updates
        "release",    // Release infrastructure
      ],
    ],
    "scope-empty": [1, "never"],
    // Subject must not be empty, no period at end
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    // Body can contain BREAKING CHANGE for major bumps
    "body-max-line-length": [1, "always", 200],
  },
};
