
FROM node:18-alpine

# The arguments inherited from GitHub variables/.env file
ARG REDIS_URL
ARG RPC_HTTP_URL
ARG RPC_USE_OWN_ONLY
ARG PEER_COUNT
ARG PEER_INDEX
ARG SEED_PHRASE

ARG SYMBOL
ARG WALLET_INDEX

WORKDIR /app

COPY package*.json ./

COPY yarn.lock ./

RUN yarn install 

COPY . .

#Appended arguments need the below structure of the command to be work
RUN echo -e "REDIS_URL=${REDIS_URL}\n""RPC_HTTP_URL=${RPC_HTTP_URL}\n""RPC_USE_OWN_ONLY=${RPC_USE_OWN_ONLY}\n""PEER_COUNT=${PEER_COUNT}\n""PEER_INDEX=${PEER_INDEX}\n""SEED_PHRASE=${SEED_PHRASE}\n" > .env

RUN yarn build

CMD yarn start-relayer ${SYMBOL} ${WALLET_INDEX}
# CMD ["yarn", "start-relayer", SYMBOL, WALLET_INDEX]