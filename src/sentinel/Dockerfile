FROM node:18-alpine

ARG SDK_CONFIG
ARG REDIS_HOST
ARG REDIS_PORT

WORKDIR /app

COPY . .

RUN yarn install 

COPY . .

# RUN echo -e "SDK_CONFIG=${SDK_CONFIG}\n""REDIS_HOST=${REDIS_HOST}\n""REDIS_PORT=${REDIS_PORT}\n" > .env

RUN yarn build

CMD yarn start-sentinel
