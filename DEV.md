# Build

- create .npmrc from dotnpmrcexample
- set environment variable NODE_AUTH_TOKEN to a Personal Access Token that can read packages
- yarn
- yarn build
- when pushing to main/dev packages are built


# Deploy
- setup ssh config for server (for example: `LIQUIDATORS_NODE_V2`)
- make config file "live.liquidatorConfig.json", prometeus files and .env file available and copy to server
- `scp docker-compose.yml LIQUIDATORS_NODE_V2:/home/quantena/d8x-liquidator`
- on server, check location of config file vs where docker-compose.yml looks for it
- export GITHUB_TOKEN=...
- export GUSER=..
- echo $GITHUB_TOKEN | docker login ghcr.io -u $GUSER --password-stdin
- docker compose up -d