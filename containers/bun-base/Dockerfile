# VaultOre Bun Runtime
# TypeScript/JavaScript execution via Bun
#
# Size: ~80MB
# Cold start: <100ms

FROM oven/bun:1-alpine

# Security: Create non-root user
RUN addgroup -g 1000 vaultore && \
    adduser -u 1000 -G vaultore -s /bin/sh -D vaultore

# Create workspace directories
RUN mkdir -p /workspace /output /tmp && \
    chown -R vaultore:vaultore /workspace /output /tmp

# Set working directory
WORKDIR /workspace

# Switch to non-root user
USER vaultore

# Default command
CMD ["bun", "--version"]
