FROM node:24-bookworm-slim AS camera-media-builder
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates libssl-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY native ./native
RUN cmake -S native -B build -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR=/usr \
    && cmake --build build --target haus-camera-media --parallel 2

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini python3-venv \
    && python3 -m venv /opt/vision-env \
    && /opt/vision-env/bin/pip install --no-cache-dir opencv-python-headless==4.12.0.88 numpy==2.2.6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node lib ./lib
COPY --from=camera-media-builder /src/build/haus-camera-media /usr/local/bin/haus-camera-media
RUN chmod 755 /usr/local/bin/haus-camera-media
COPY --chown=node:node vision ./vision
RUN node vision/fetch-model.mjs
RUN /opt/vision-env/bin/python3 vision/test_motion.py
RUN --mount=type=bind,source=test,target=/app/test,readonly node --test test/playback-process.test.mjs
RUN --mount=type=bind,source=test,target=/app/test,readonly HAUS_CAMERA_MEDIA_BIN=/usr/local/bin/haus-camera-media node --test test/camera-media-native.test.mjs test/native-camera-media.test.mjs test/native-rtp-burst.test.mjs test/native-interleaved-writer.test.mjs test/native-browser-answer.test.mjs
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HAUS_DATA=/data HAUS_CONTAINER=true
EXPOSE 8098 8555-8586/udp
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8098/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/main.mjs"]
