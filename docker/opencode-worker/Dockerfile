FROM node:20-slim

# Install system dependencies (glibc-based image for opencode binary compatibility)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl openssh-client ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*

# Install opencode CLI binary via official installer
RUN curl -fsSL https://opencode.ai/install | bash 2>/dev/null || true
# Move opencode to a standard PATH location
RUN cp /root/.opencode/bin/opencode /usr/local/bin/opencode && chmod +x /usr/local/bin/opencode

# Install the OpenCode SDK globally
RUN npm install -g @opencode-ai/sdk

# Set NODE_PATH so server.mjs can resolve global npm modules
ENV NODE_PATH=/usr/local/lib/node_modules

# Create non-root user
RUN useradd -m -u 1001 -s /bin/bash opencode

# Create directories for config, data, and repos
RUN mkdir -p /home/opencode/.local/share/opencode \
             /home/opencode/.config/opencode \
             /home/opencode/repos \
    && chown -R opencode:opencode /home/opencode

# Create the server entry point script
RUN cat > /home/opencode/server.mjs << 'EOF'
import { createOpencodeServer } from '@opencode-ai/sdk';

const port = parseInt(process.env.OPENCODE_PORT || '4096');
const server = await createOpencodeServer({ hostname: '0.0.0.0', port });
console.log(`OpenCode server running at ${server.url}`);

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });

// Keep alive
setInterval(() => {}, 60000);
EOF
RUN chown opencode:opencode /home/opencode/server.mjs

# Copy entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /home/opencode

# Environment defaults
ENV OPENCODE_PORT=4096
ENV REPOS_DIR=/home/opencode/repos

EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=5 \
  CMD curl -f http://localhost:4096/ || exit 1

USER opencode

ENTRYPOINT ["entrypoint.sh"]
