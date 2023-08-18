
FROM node:18-alpine

# The arguments inherited from GitHub variables/.env file
ARG REDIS_URL
ARG CHAIN_ID
ARG PEER_COUNT
ARG PEER_INDEX
ARG SEED_PHRASE
ARG TREASURY_INDEX

ARG SYMBOL
ARG WALLET_INDEX

WORKDIR /app

COPY package*.json ./

COPY yarn.lock ./

RUN yarn install 

COPY . .

#Appended arguments need the below structure of the command to be work
RUN echo -e "REDIS_URL=${REDIS_URL}\n""CHAIN_ID=${CHAIN_ID}\n""TREASURY_INDEX=${TREASURY_INDEX}\n""PEER_COUNT=${PEER_COUNT}\n""PEER_INDEX=${PEER_INDEX}\n""SEED_PHRASE=${SEED_PHRASE}\n" > .env

RUN yarn build

CMD yarn start-liquidator ${SYMBOL} ${WALLET_INDEX}