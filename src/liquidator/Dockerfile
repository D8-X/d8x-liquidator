
FROM node:18-alpine

# The arguments inherited from GitHub variables/.env file
ARG EARNINGS_WALLET
ARG CHAIN_ID
ARG REDIS_URL
ARG PEER_COUNT
ARG PEER_INDEX
ARG SEED_PHRASE
ARG ACCOUNTS_PER_BOT

ARG SYMBOL
ARG WALLET_INDEX

WORKDIR /app

COPY . .

RUN yarn install 

COPY . .

#Appended arguments need the below structure of the command to be work
RUN echo -e "ACCOUNTS_PER_BOT=${ACCOUNTS_PER_BOT}\n""EARNINGS_WALLET=${EARNINGS_WALLET}\n""CHAIN_ID=${CHAIN_ID}\n""REDIS_URL=${REDIS_URL}\n""PEER_COUNT=${PEER_COUNT}\n""PEER_INDEX=${PEER_INDEX}\n""SEED_PHRASE=${SEED_PHRASE}\n" > .env

RUN yarn build


CMD yarn start-liquidator ${SYMBOL} ${WALLET_INDEX}