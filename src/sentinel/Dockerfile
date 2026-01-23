# syntax=docker/dockerfile:1.6
FROM node:20-alpine

ARG SDK_CONFIG
ARG REDIS_HOST
ARG REDIS_PORT
ARG REDIS_ID

WORKDIR /app

# (optional but common) native deps for node-gyp builds
# RUN apk add --no-cache python3 make g++

# Copy only dependency manifests first for caching
COPY package.json yarn.lock ./

# Install deps with ephemeral .npmrc (token passed as secret)
RUN --mount=type=secret,id=npm_token \
    sh -c 'echo "@d8-x:registry=https://npm.pkg.github.com" > .npmrc && \
           echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/npm_token)" >> .npmrc && \
           yarn install --frozen-lockfile && \
           rm -f .npmrc'

# Now copy the rest and build
COPY . .

RUN yarn build

CMD ["yarn", "start-sentinel"]
