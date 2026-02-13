FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl openssh-client ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://opencode.ai/install | bash 2>/dev/null || true
RUN cp /root/.opencode/bin/opencode /usr/local/bin/opencode && chmod +x /usr/local/bin/opencode

RUN useradd -m -u 1001 -s /bin/bash opencode

RUN mkdir -p /home/opencode/.local/share/opencode \
             /home/opencode/.config/opencode \
             /home/opencode/repos \
    && chown -R opencode:opencode /home/opencode

WORKDIR /home/opencode

# Install SDK locally so ESM imports can resolve it
RUN echo '{"type":"module","dependencies":{"@opencode-ai/sdk":"*"}}' > package.json \
    && npm install --omit=dev \
    && chown -R opencode:opencode /home/opencode/node_modules /home/opencode/package.json /home/opencode/package-lock.json

COPY server.mjs /home/opencode/server.mjs
RUN chown opencode:opencode /home/opencode/server.mjs

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV OPENCODE_PORT=4096
ENV REPOS_DIR=/home/opencode/repos

EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=5 \
  CMD curl -f http://localhost:4096/ || exit 1

USER opencode

ENTRYPOINT ["entrypoint.sh"]
