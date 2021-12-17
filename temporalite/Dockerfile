FROM --platform=linux/arm64/v8 golang:1.17.5-bullseye AS builder

RUN go install github.com/DataDog/temporalite/cmd/temporalite@latest

CMD ["/go/bin/temporalite", "start", "--ip", "0.0.0.0", "--namespace", "default", "-f", "/work/temporalite.db"]
