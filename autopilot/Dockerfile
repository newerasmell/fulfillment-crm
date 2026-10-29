# Isolated build box for the autopilot. Holds NO production vendor credentials and NO production DB URL.
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git jq python3 curl ca-certificates gh postgresql-client \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && npm install -g @anthropic-ai/claude-code
RUN useradd -m -s /bin/bash builder
USER builder
WORKDIR /work
CMD ["bash", "-lc", "gh auth setup-git && bash autopilot/run.sh"]
