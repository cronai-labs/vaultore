# VaultOre Shell Runtime
# Bash/Shell command execution
#
# Size: ~50MB
# Cold start: <50ms

FROM alpine:3.19

# Install common shell utilities
RUN apk add --no-cache \
    bash \
    curl \
    wget \
    jq \
    yq \
    grep \
    sed \
    gawk \
    coreutils \
    findutils \
    procps

# Security: Create non-root user
RUN addgroup -g 1000 vaultore && \
    adduser -u 1000 -G vaultore -s /bin/bash -D vaultore

# Create workspace directories
RUN mkdir -p /workspace /output /tmp && \
    chown -R vaultore:vaultore /workspace /output /tmp

WORKDIR /workspace
USER vaultore

# Use bash by default
SHELL ["/bin/bash", "-c"]
CMD ["bash", "--version"]
