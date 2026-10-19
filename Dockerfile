FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini python3-venv \
    && python3 -m venv /opt/vision-env \
    && /opt/vision-env/bin/pip install --no-cache-dir opencv-python-headless==4.12.0.88 numpy==2.2.6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node vision ./vision
RUN node vision/fetch-model.mjs
RUN /opt/vision-env/bin/python3 vision/test_motion.py
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HAUS_DATA=/data
EXPOSE 8098
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8098/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/main.mjs"]
