FROM node:20-alpine AS frontend

# donetick/frontend develop, closest after backend v0.1.75 (2026-04-20)
ARG DONETICK_FRONTEND_COMMIT=ca7d71eed419f41b02226006f1e632728b995822

RUN apk --no-cache add git

WORKDIR /frontend

RUN git init && \
    git remote add origin https://github.com/donetick/frontend.git && \
    git fetch --depth 1 origin ${DONETICK_FRONTEND_COMMIT} && \
    git checkout FETCH_HEAD

RUN npm run build-selfhosted

FROM golang:1.24-alpine AS builder

# donetick/donetick v0.1.75
ARG DONETICK_COMMIT=eb5c9be4c2abcf3ccdb26f889b10fa44f798e172

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
