
FROM node:18-alpine

# The arguments inherited from GitHub variables/.env file
ARG REDIS_URL
ARG RPC_HTTP_URL
ARG RPC_WS_URL
ARG CHAIN_ID

WORKDIR /app

COPY package*.json ./

COPY yarn.lock ./

RUN yarn install 

COPY . .

#Appended arguments need the below structure of the command to be work
RUN echo -e "REDIS_URL=${REDIS_URL}\n""CHAIN_ID=${CHAIN_ID}\n""RPC_HTTP_URL=${RPC_HTTP_URL}\n""RPC_WS_URL=${RPC_WS_URL}\n" > .env

RUN yarn build

CMD ["yarn", "start-streamer"]
