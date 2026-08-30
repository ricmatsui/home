FROM node:24.14-trixie@sha256:81649592d9833d9220423561fc517b34e932b751873274024c2a969ff4a9bfc2 AS build

WORKDIR /home/node/app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public

RUN yarn run build

FROM nginx:1.29.5@sha256:341bf0f3ce6c5277d6002cf6e1fb0319fa4252add24ab6a0e262e0056d313208

COPY --from=build /home/node/app/dist /usr/share/nginx/html
COPY nginx/default.conf.template /etc/nginx/templates/
