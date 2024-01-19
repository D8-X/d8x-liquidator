
FROM node:18-alpine

# The arguments inherited from GitHub variables/.env file
ARG SDK_CONFIG
ARG REDIS_URL

WORKDIR /app

COPY . .

RUN yarn install 

COPY . .

#Appended arguments need the below structure of the command to be work
RUN echo -e "SDK_CONFIG=${SDK_CONFIG}\n""REDIS_URL=${REDIS_URL}\n" > .env

RUN yarn build

CMD ["yarn", "start-listener"]
