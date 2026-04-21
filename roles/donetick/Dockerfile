FROM node:20-alpine AS frontend

# donetick/frontend v0.1.71 dev
ARG DONETICK_FRONTEND_COMMIT=d8d7b6a7660b2e2cf40f318b400e466bc2edc964

RUN apk --no-cache add git

WORKDIR /frontend

RUN git init && \
    git remote add origin https://github.com/donetick/frontend.git && \
    git fetch --depth 1 origin ${DONETICK_FRONTEND_COMMIT} && \
    git checkout FETCH_HEAD

RUN npm run build-selfhosted

FROM golang:1.24-alpine AS builder

# donetick/donetick v0.1.71
ARG DONETICK_COMMIT=9ebd53b1cd39b73250a897696dc9e987c2ea93aa

RUN apk --no-cache add git

WORKDIR /src

RUN git init && \
    git remote add origin https://github.com/donetick/donetick.git && \
    git fetch --depth 1 origin ${DONETICK_COMMIT} && \
    git checkout FETCH_HEAD

COPY --from=frontend /frontend/dist ./frontend/dist

COPY patches ./patches
RUN git apply patches/*.patch

RUN go build -o donetick .

FROM alpine:latest

RUN apk --no-cache add ca-certificates libc6-compat tzdata

COPY --from=builder /src/donetick /donetick
COPY --from=builder /src/config /config

ENV DT_ENV="selfhosted"

EXPOSE 2021

CMD ["/donetick"]
