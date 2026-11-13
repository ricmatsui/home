# syntax=docker/dockerfile:1

# Rebuilds Debian bookworm's glusterfs 10.3-5 for amd64 and arm64 with the
# toolchain and build path of each official build, checks the stock bit-rot.so
# is byte-identical to the shipped one, then rebuilds it with patches/ applied.

FROM debian:bookworm-20230522@sha256:fec4afb3946a3de54839a8b7da9c8026f1c4af4f9ae47d6d030aa567a77437a5 AS base

# Serial: under Rosetta, lto-wrapper's make dies with "write jobserver: Bad file
# descriptor"; the job count doesn't change the output
FROM base AS base-amd64
ENV BUILD_DIR=/build/glusterfs-ypMC99 \
    JOBS=1 \
    MULTIARCH=x86_64-linux-gnu \
    STOCK_SHA256=41b0d111a88f771fe79e854a8d6a3a44edf63b44b313e14c5cfa2a2545abd4cc

FROM base AS base-arm64
ENV BUILD_DIR=/build/glusterfs-zJ6EPY \
    MULTIARCH=aarch64-linux-gnu \
    STOCK_SHA256=ae93bd76dc6fa603a52bb47b0164896e98ad3e1d55c39c2fe2d2498684089f66

FROM base-${TARGETARCH} AS source
SHELL ["/bin/bash", "-Eeuo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
ARG APT="apt-get -qq -o Acquire::Retries=10"

# Binaries as of the official builds (2023-05-24); 10.3-5 reached bookworm by release
RUN rm -f /etc/apt/sources.list.d/debian.sources
COPY <<EOF /etc/apt/sources.list
deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20230525T000000Z bookworm main
deb-src [check-valid-until=no] http://snapshot.debian.org/archive/debian/20230610T000000Z bookworm main
EOF
RUN $APT update && $APT install -y dpkg-dev patch > /dev/null

WORKDIR $BUILD_DIR
RUN $APT source glusterfs=10.3-5 > /dev/null && $APT build-dep -y ./glusterfs_10.3-5.dsc > /dev/null
WORKDIR $BUILD_DIR/glusterfs-10.3

ENV SO=debian/glusterfs-common/usr/lib/$MULTIARCH/glusterfs/10.3/xlator/features/bit-rot.so

FROM source AS stock
RUN dpkg-buildpackage -B -uc -us -j"${JOBS:-$(nproc)}" > /build/stock.log 2>&1 || { tail -n 100 /build/stock.log; exit 1; }
RUN echo "$STOCK_SHA256  $SO" | sha256sum -c

FROM stock AS patched
COPY patches/ /patches/
RUN for patch in /patches/*.patch; do patch -p1 --no-backup-if-mismatch < "$patch"; done
RUN rm -f debian/debhelper-build-stamp debian/*.debhelper.log \
 && { dpkg-buildpackage -B -nc -uc -us -j"${JOBS:-$(nproc)}" > /build/patched.log 2>&1 || { tail -n 100 /build/patched.log; exit 1; }; } \
 && cp "$SO" /bit-rot.so

FROM scratch
COPY --from=patched /bit-rot.so /
