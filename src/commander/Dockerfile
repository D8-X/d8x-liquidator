FROM node:18-alpine

ARG SDK_CONFIG
ARG REDIS_URL

WORKDIR /app

COPY . .

RUN yarn install 

COPY . .

RUN echo -e "SDK_CONFIG=${SDK_CONFIG}\n""REDIS_URL=${REDIS_URL}\n" > .env

RUN yarn build

CMD yarn start-commander
