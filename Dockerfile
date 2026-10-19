FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node lib ./lib
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HAUS_DATA=/data
EXPOSE 8098
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8098/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/main.mjs"]
