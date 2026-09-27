FROM node:22-alpine

# git is the only runtime dependency: the scanner shells out to it.
RUN apk add --no-cache git tini \
 && git config --system --add safe.directory '*'

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8420 \
    PROJECTS_ROOT=/projects \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8420

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8420/api/health >/dev/null || exit 1

USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
