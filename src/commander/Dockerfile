# syntax=docker/dockerfile:1.6
FROM node:20-alpine

ARG SDK_CONFIG
ARG REDIS_HOST
ARG REDIS_PORT
ARG REDIS_ID

WORKDIR /app

# Cache deps
COPY package.json yarn.lock ./

# Private GitHub Packages install (ephemeral .npmrc)
RUN --mount=type=secret,id=npm_token \
    sh -c 'TOKEN="$(cat /run/secrets/npm_token)" && \
           echo "@d8-x:registry=https://npm.pkg.github.com" > .npmrc && \
           echo "always-auth=true" >> .npmrc && \
           echo "//npm.pkg.github.com/:_authToken=${TOKEN}" >> .npmrc && \
           yarn install --frozen-lockfile && \
           rm -f .npmrc'

# Copy app sources and build
COPY . .

RUN yarn build

CMD ["yarn", "start-commander"]
