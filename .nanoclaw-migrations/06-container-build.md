# 06 — Container build improvements (Dockerfile + build.sh)

**Apply when:** Skill `upstream/skill/qmd` has been merged (the Dockerfile already has skill-introduced edits). These customizations layer on top.

**Why:**
1. **Python 3.13 in the container.** Some agent tasks need newer Python than Debian Bookworm's bundled 3.11.
2. **`ffmpeg` system package.** Voice/media transcription tasks need it.
3. **Graceful `.env` mount fallback.** The bind-mount of `/dev/null` over `.env` shouldn't fail the container start when `.env` doesn't exist (e.g. CI / clean test runs).
4. **Default container runtime to `container`** (Apple Container) on the user's macOS dev box. The skills set Docker as the default; the user prefers Apple Container locally.

**Files affected:**
- `container/Dockerfile`
- `container/build.sh`
- The `entrypoint.sh` printf inside `container/Dockerfile` (the script is generated inline)

---

## How to apply

### 1. `container/Dockerfile` — multi-stage Python 3.13

At the very top of the Dockerfile, **before** the existing `FROM node:22-slim` (or whatever the main base is in the new upstream), add a Python 3.13 stage:

```dockerfile
# Stage 1: pull Python 3.13 compiled for Debian Bookworm (glibc 2.36-compatible)
FROM python:3.13-slim-bookworm AS python313

# Stage 2: main container
FROM node:22-slim
```

After the `FROM node:22-slim` (and before the apt-get install block, or wherever fits the upstream layout), add the COPY commands and `ldconfig`:

```dockerfile
# Copy Python 3.13 binary, stdlib, and shared library from the python:3.13-slim-bookworm stage.
# (compiled against glibc 2.36 — compatible with this container's Debian Bookworm base)
COPY --from=python313 /usr/local/bin/python3.13 /usr/local/bin/python3.13
COPY --from=python313 /usr/local/lib/python3.13 /usr/local/lib/python3.13
COPY --from=python313 /usr/local/lib/libpython3.13.so.1.0 /usr/local/lib/libpython3.13.so.1.0
RUN ldconfig
```

### 2. `container/Dockerfile` — add `ffmpeg`

Find the `apt-get install` block. Add `ffmpeg \` to the package list. Example final shape:

```dockerfile
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    curl \
    git \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
```

(The exact list will vary with the new upstream — just append `ffmpeg \` to whatever's there.)

### 3. `container/Dockerfile` — graceful entrypoint mount fallback

The entrypoint script is generated inline in the Dockerfile via a heredoc / printf. Find the `mount --bind /dev/null /workspace/project/.env` line and append `|| true`:

```bash
# Inside the entrypoint script as written by the Dockerfile:
if [ "$(id -u)" = "0" ] && [ -f /workspace/project/.env ]; then
  mount --bind /dev/null /workspace/project/.env || true
fi
```

The `|| true` makes container start succeed even if the bind-mount fails (e.g. on Apple Container where file mounts behave differently).

### 4. `container/build.sh` — default runtime

Find the line that sets the default runtime. The skill leaves it as Docker; the user changes it to Apple Container:

```bash
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"
```

The override (`CONTAINER_RUNTIME=docker`) still works for users who prefer Docker.

---

## Verification

```bash
./container/build.sh
```

The build must succeed. Confirm Python 3.13 and ffmpeg are present inside the resulting image:

```bash
container run --rm <image-name> python3.13 --version
container run --rm <image-name> ffmpeg -version
```

(Use `docker run` if Docker is the active runtime.)

---

## Reasoning to retain

Original commit: `f4fe718 fix: container improvements — Python 3.13, ffmpeg, QMD conditional, uid handling`.

The QMD-conditional and uid-handling parts of that commit are split into separate documents (03 and 02 respectively). Only Dockerfile + build.sh changes are captured here.
