FROM --platform=$BUILDPLATFORM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build

ARG TARGETOS
ARG TARGETARCH
ARG GO2RTC_REPO="https://github.com/ricmatsui/go2rtc.git"
# nest-fix-1.9.10
ARG GO2RTC_REF="cbce03dd49fd0220e155a52c6ce070d27a2d3377"

ENV GOOS=${TARGETOS}
ENV GOARCH=${TARGETARCH}
ENV CGO_ENABLED=0

WORKDIR /build

RUN apk add --no-cache git

RUN git init -q . \
    && git remote add origin "${GO2RTC_REPO}" \
    && git fetch -q --depth 1 origin "${GO2RTC_REF}" \
    && git checkout -q --detach FETCH_HEAD

RUN go build -ldflags "-s -w" -trimpath


FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

RUN apk add --no-cache tini ffmpeg ffplay bash curl jq

COPY --from=build /build/go2rtc /usr/local/bin/

ENTRYPOINT ["/sbin/tini", "--"]
VOLUME /config
WORKDIR /config
CMD ["go2rtc", "-config", "/config/go2rtc.yaml"]
