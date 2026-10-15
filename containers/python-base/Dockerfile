# VaultOre Python Runtime
# Python 3 execution
#
# As of 2026-10-15 nothing builds or runs this image: the executor
# (packages/core/src/executor/index.ts) rejects ore:py cells as unsupported.

FROM python:3.12-alpine

# Install build dependencies
RUN apk add --no-cache \
    gcc \
    musl-dev \
    libffi-dev

# Security: Create non-root user
RUN addgroup -g 1000 vaultore && \
    adduser -u 1000 -G vaultore -s /bin/sh -D vaultore

# Create directories
RUN mkdir -p /workspace /output /tmp && \
    chown -R vaultore:vaultore /workspace /output /tmp

# Install common packages
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements.txt && \
    rm /tmp/requirements.txt

WORKDIR /workspace
USER vaultore

CMD ["python", "--version"]
