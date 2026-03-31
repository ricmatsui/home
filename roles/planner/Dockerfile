FROM node:24.14-trixie@sha256:81649592d9833d9220423561fc517b34e932b751873274024c2a969ff4a9bfc2

WORKDIR /home/node/app

COPY package.json yarn.lock ./
COPY patches ./patches
RUN yarn install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

RUN yarn run build

USER node

CMD ["node", "dist/index.js"]
