# syntax=docker/dockerfile:1
#
# EZAT dev dashboard. The app lives at /ezat/dev-dashboard so its default
# REPOS_ROOT (the parent folder, /ezat) lines up with the sibling repos that
# docker-compose.yml mounts next to it.

ARG NODE_VERSION=24
# Node versions the sibling repos pin in .nvmrc. The dashboard looks for each
# one at $NVM_DIR/versions/node/v<pin>/bin, so they are baked in here.
# Keep in sync with /ezat/.nvmrc, Portage-backend/.nvmrc and TravelTracker/.nvmrc.
ARG NODE_PINS="20.18.0 20.19.0"

# 1. Build the React UI (needs devDependencies).
FROM node:${NODE_VERSION}-bookworm-slim AS ui-build
WORKDIR /ezat/dev-dashboard
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2. Fetch the pinned Node runtimes, checked against nodejs.org's SHASUMS256.
FROM node:${NODE_VERSION}-bookworm-slim AS node-runtimes
ARG NODE_PINS
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64) arch=x64 ;; \
      aarch64) arch=arm64 ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    for v in $NODE_PINS; do \
      dir="/nvm/versions/node/v$v"; \
      file="node-v$v-linux-$arch.tar.xz"; \
      mkdir -p "$dir"; \
      curl -fsSLO "https://nodejs.org/dist/v$v/$file"; \
      curl -fsSL "https://nodejs.org/dist/v$v/SHASUMS256.txt" | grep " $file\$" | sha256sum -c -; \
      tar -xJf "$file" -C "$dir" --strip-components=1; \
      rm "$file"; \
    done

# 3. The runtime image.
FROM node:${NODE_VERSION}-bookworm-slim
# git: PR diffs run git in the sibling repos. lsof: port freeing. openssl: Prisma.
# tini: PID 1 that reaps the detached service processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git lsof openssl tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pm2@7.0.4 \
 && npm cache clean --force

ENV HOME=/home/node \
    NVM_DIR=/home/node/.nvm

COPY --from=node-runtimes --chown=node:node /nvm/ /home/node/.nvm/

# Sibling repos are bind mounts owned by the host user, so trust them for git.
# GitHub https fetches authenticate with GH_TOKEN from the environment.
COPY docker/git-credential-env.sh /usr/local/bin/git-credential-env
RUN chmod 0755 /usr/local/bin/git-credential-env \
 && git config --system safe.directory '*' \
 && git config --system credential.https://github.com.helper /usr/local/bin/git-credential-env

WORKDIR /ezat/dev-dashboard
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
COPY --from=ui-build /ezat/dev-dashboard/dist ./dist
RUN chmod 0755 docker/entrypoint.sh \
 && mkdir -p logs /home/node/.config /home/node/.npm \
 && chown -R node:node logs /home/node/.config /home/node/.npm

EXPOSE 6500
ENTRYPOINT ["/usr/bin/tini", "--", "/ezat/dev-dashboard/docker/entrypoint.sh"]
CMD ["node", "backend/server.mjs"]
