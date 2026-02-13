FROM node:20-alpine

# Install system dependencies
RUN apk add --no-cache git curl openssh-client

# Install opencode CLI and SDK globally
RUN npm install -g @opencode-ai/opencode @opencode-ai/sdk

# Create non-root user
RUN adduser -D -u 1000 -h /home/opencode opencode

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

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:4096/ || exit 1

USER opencode

ENTRYPOINT ["entrypoint.sh"]
