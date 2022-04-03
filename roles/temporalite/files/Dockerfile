FROM golang@sha256:67dd7b9ac7d53f748478667507fa68d1e567920262da13b110c72f49249e1cb2 AS builder

RUN go install github.com/DataDog/temporalite/cmd/temporalite@493a7273f4903a5a2fae772216cfc7abab970a43

CMD ["/go/bin/temporalite", "start", "--ip", "0.0.0.0", "--namespace", "default", "-f", "/work/temporalite.db"]
