# VaultOre Go Builder
# Compile and run Go cells
#
# Size: ~250MB (includes Go toolchain)
# Cold start: <300ms (build), <50ms (cached run)
#
# NOTE: This is for v0.3+ and not required for MVP

FROM golang:1.23-alpine

# Install build dependencies
RUN apk add --no-cache \
    git \
    ca-certificates \
    tzdata

# Security: Create non-root user
RUN addgroup -g 1000 vaultore && \
    adduser -u 1000 -G vaultore -s /bin/sh -D vaultore

# Create directories
RUN mkdir -p /workspace /output /tmp /home/vaultore/go && \
    chown -R vaultore:vaultore /workspace /output /tmp /home/vaultore

# Set Go environment
ENV GOPATH=/home/vaultore/go
ENV GOCACHE=/home/vaultore/.cache/go-build
ENV GOMODCACHE=/home/vaultore/go/pkg/mod

WORKDIR /workspace
USER vaultore

CMD ["go", "version"]
