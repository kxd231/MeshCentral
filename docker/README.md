# MeshCentral Docker Configuration Guide

> [!NOTE]
> Out of precaution, DYNAMIC_CONFIG has been disabled by default.<br>
> The reason why is because when its enabled and a working config without corresponding environment variables gives,<br>
> Then the container will overwrite it to a incorrect, but working state - perhaps non-working for your environment.

## Web-RDP with FreeRDP, built from source

`docker/Dockerfile` and `docker/Dockerfile-debian` build the native Web-RDP helper (`meshfreerdp`, FreeRDP 3) into
the image. A prebuilt image (linux/amd64 and linux/arm64) is published as `ghcr.io/kxd231/meshcentral:dev-test`
by `.github/workflows/docker-freerdp.yml`. `docker/compose.new.yaml` runs it with a config file you control:

```bash
cp docker/config.example.json docker/config.json
# edit docker/config.json: "cert" (DNS name or IP), "port"/"redirPort", and enable "sessionKey"
docker compose -f docker/compose.new.yaml pull
docker compose -f docker/compose.new.yaml up -d
```

To build the image from this source tree instead, use `docker compose -f docker/compose.new.yaml up -d --build`.
Set `MC_IMAGE` to use another image name or tag.

Optional variables, set in `docker/.env` (next to the compose file):

| Variable | Default | Meaning |
|----------|---------|---------|
| `MC_HTTPS_PORT` | 443 | Published HTTPS port. Must equal `settings.port` in `config.json`. |
| `MC_HTTP_PORT` | 80 | Published HTTP port. Must equal `settings.redirPort`. |
| `MC_TZ` | UTC | Container time zone. |
| `MC_IMAGE` | ghcr.io/kxd231/meshcentral:dev-test | Image to pull or to tag a local build with. |
| `MC_STYLISHUI` | false | Install the third-party [Stylish UI](https://github.com/Melo-Professional/MeshCentral-Stylish-UI) theme on start (set `domains[""].siteStyle` to 3). |

`config.json` and `.env` are ignored by git and by the Docker build context. The config is mounted read-only
and `DYNAMIC_CONFIG` is off, so the entrypoint never rewrites it; restart the container after editing it
(`docker compose -f docker/compose.new.yaml restart`). Code changes need `up -d --build`.

The first account created on the login page becomes the site administrator.

### Custom agent builds

MeshCentral can serve your own agent binaries instead of the default ones. A release manifest lists each
file with its exact size and SHA384; it is laid over the shipped `agents/agent-defaults.json`, so files it does
not list keep the default agents. See `docker/agent-overrides.example.json`.

Files are looked up in `meshcentral-data/agentbuilds/<tag>/<filename>`. When the release repository is public,
MeshCentral downloads missing files itself. For a private repository or a local build, copy the files in yourself.
`meshcentral-data` is a Docker volume, so copy them through the container:

```bash
# on the build machine: size and hash for the manifest
stat -c %s MeshService64.exe
sha384sum MeshService64.exe

# on the Docker host
D=/opt/meshcentral/meshcentral-data
docker exec meshcentral mkdir -p $D/agentbuilds/my-build-1
docker exec -i meshcentral sh -c "cat > $D/agent-overrides.json" < agent-overrides.json
docker exec -i meshcentral sh -c "cat > $D/agentbuilds/my-build-1/MeshService64.exe" < MeshService64.exe
```

Then point `config.json` at the manifest and restart the container:

```json
"settings": {
  "agentDownloads": { "manifest": "agent-overrides.json" }
}
```

After the restart a `SHA256SUMS` file appears next to the agent and `https://<server>/meshagents` shows the new
hash (Windows x64 is id 4). A file whose size or SHA384 does not match is not served. The Alpine image has no
`sha384sum`; to check a file inside the container use
`docker exec meshcentral node -e "console.log(require('crypto').createHash('sha384').update(require('fs').readFileSync('$D/agentbuilds/my-build-1/MeshService64.exe')).digest('hex'))"`.

The files and the manifest live in the `meshcentral-data` volume, so image rebuilds keep them; `down -v` removes them.
For a new build, copy it to a new `<tag>` folder, update `tag`, `size` and `sha384` in the manifest and restart.
With a private release repository the scheduled release check reports a 404 in the server status; serving the
copied files is not affected. Set `"checkIntervalHours": 0` in `agentDownloads` to turn the check off.

## Overview
This document provides a comprehensive guide to setting up and configuring MeshCentral in a Docker environment.<br>
It includes available options, security measures, and deployment instructions.

MeshCentral provides a couple different Docker container variants:<br>
These variants are pulled through 3 main channels: `master` and `latest`.<br>
If you want to target versions, you can also target individual versions; such as `1.1.53`.

| Variant | Image tag | Full path |
|---------|-----------|-----------|
| All database backends | "" (empty) | ghcr.io/ylianst/meshcentral:\<version\> |
| No database backens (local only) | slim | ghcr.io/ylianst/meshcentral:\<version\>-slim |
| [MongoDB](https://www.mongodb.com/) backend included | mongodb | ghcr.io/ylianst/meshcentral:\<version\>-mongodb |
| [PostgreSQL](https://www.postgresql.org/) backend included | postgresql | ghcr.io/ylianst/meshcentral:\<version\>-postgresql |
| [Mysql](https://www.mysql.com/)/[MariaDB](https://mariadb.org/) backend(s) included | mysql | ghcr.io/ylianst/meshcentral:\<version\>-mysql |

So for a quick example: if you want to get the bleeding edge code with a PostgreSQL backend: `ghcr.io/ylianst/meshcentral:master-postgresql`<br>
So for another quick example: if you want to get a complete image at the latest released version: `ghcr.io/ylianst/meshcentral:latest`<br>
So for another quick example: if you want to get a released version with a MongoDB backend: `ghcr.io/ylianst/meshcentral:latest-mongodb`<br>
So for another quick example: if you want a very slim image with the latest code and only a local database: `ghcr.io/ylianst/meshcentral:master-slim`<br>
So as a last example: if you want to get a MariaDB/MySQL backend with MeshCentral version 1.1.53: `ghcr.io/ylianst/meshcentral:1.1.53-mysql`

## Persistency

The Docker image has since recently removed its default creation of volumes. It might not be what you want.<br>
If you still want to use volumes to make data persist across containers use Docker volumes (or Kubernetes PVCs).<br>
For examples of how to use these volumes, see the examples below. Most data resides inside:

- /opt/meshcentral/meshcentral-backups
- /opt/meshcentral/meshcentral-data (most important! Server configurations, certificates, etc... reside here.)
- /opt/meshcentral/meshcentral-files
- /opt/meshcentral/meshcentral-web (relevant if you use a custom theme, such as [Stylish-UI](https://github.com/melo-professional/Meshcentral-Stylish-UI))

## Environment Variables
Below is a breakdown of environment variables used in this setup.

### General MeshCentral Configuration
| Variable | Default Value | Description |
|----------|--------------|-------------|
| NODE_ENV | production | Specifies the Node.js environment. |
| CONFIG_FILE | /opt/meshcentral/meshcentral-data/config.json | Path to the configuration file. |
| DYNAMIC_CONFIG | false | Enables/disables dynamic configuration. This means config is being rechecked every container restart. False if you want to use your own `config.json` |
| ALLOW_PLUGINS | false | Enables/disables plugins. |
| ALLOW_NEW_ACCOUNTS | false | Enables/disables new account creation. |
| ALLOWED_ORIGIN | false | Enables/disables allowed origin policy. |
| ARGS | "" | Additional arguments for MeshCentral. |
| HOSTNAME | localhost | Specifies the hostname. |
| PORT | 443 | Specifies the port. |
| REDIR_PORT | 80 | Specifies the redirection port. |
| IFRAME | false | Enables/disables embedding in an iframe. |
| LOCAL_SESSION_RECORDING | true | Enables session recording. |
| MINIFY | true | Minifies the JavaScript and HTML output. |
| REGEN_SESSIONKEY | false | Regenerates the session key on each restart of the container. |
| REVERSE_PROXY | "" | Configures reverse proxy support through `certUrl`. |
| REVERSE_PROXY_TLS_PORT | "443" | Configures reverse proxy TLS port, will be combined with: `REVERSE_PROXY`. |
| WEBRTC | false | Enables/disables WebRTC support. |
| TRUSTED_PROXY | "" | Trust forwarded headers from these IPs or domains. |
| TLS_OFFLOAD | false | When set to true, indicate that TLS is being performed by a device in front of MeshCentral. |

### Database Configuration

#### MeshCentral Database Settings
| Variable | Default Value | Description |
|----------|--------------|-------------|
| USE_MONGODB | false | Enables MongoDB usage. |
| USE_POSTGRESQL | false | Enables PostgreSQL usage. |
| USE_MARIADB | false | Enables MariaDB usage. |

#### MongoDB Configuration
| Variable | Default Value | Description |
|----------|--------------|-------------|
| MONGO_HOST | "" | MongoDB server hostname. |
| MONGO_PORT | 27017 | MongoDB server port. |
| MONGO_USERNAME | "" | MongoDB username. |
| MONGO_PASS | "" | MongoDB password. |
| MONGO_URL | "" | Overrides other MongoDB connection settings. |

#### PostgreSQL Configuration
| Variable | Default Value | Description |
|----------|--------------|-------------|
| PSQL_HOST | "" | PostgreSQL server hostname. |
| PSQL_PORT | 5432 | PostgreSQL server port. |
| PSQL_USER | "" | PostgreSQL username. |
| PSQL_PASS | "" | PostgreSQL password. |
| PSQL_DATABASE | "" | PostgreSQL database name. |

#### MariaDB Configuration
| Variable | Default Value | Description |
|----------|--------------|-------------|
| MARIADB_HOST | "" | MariaDB server hostname. |
| MARIADB_PORT | 3306 | MariaDB server port. |
| MARIADB_USER | "" | MariaDB username. |
| MARIADB_PASS | "" | MariaDB password. |
| MARIADB_DATABASE | "" | MariaDB database name. |

## Deployment Instructions

### Running with Docker CLI
```sh
docker run -d \
  -e HOSTNAME=myserver.domain.com \
  -e ALLOW_NEW_ACCOUNTS=true \
  -e USE_MONGODB=true \
  -e MONGO_URL=mongodb://username:password@mongodb:27017/meshcentral \
  -v meshcentral-data:/opt/meshcentral/meshcentral-data \
  -p 443:443 \
  ghcr.io/ylianst/meshcentral:latest # or latest-mongodb
```

### Running with Docker Compose
```yaml
services:
  meshcentral:
    image: ghcr.io/ylianst/meshcentral:latest
    environment:
      - HOSTNAME=myserver.domain.com
      - ALLOW_NEW_ACCOUNTS=false
      - USE_MONGODB=true
      - MONGO_URL=mongodb://username:password@mongodb:27017/meshcentral
    volumes:
      - meshcentral-data:/opt/meshcentral/meshcentral-data
      - meshcentral-files:/opt/meshcentral/meshcentral-files
      - meshcentral-web:/opt/meshcentral/meshcentral-web
      - meshcentral-backups:/opt/meshcentral/meshcentral-backups
    ports:
    # You can add additional ports here in the same format. Such as for AMT or HTTP
      - "443:443"
volumes:
  meshcentral-data:
  meshcentral-files:
  meshcentral-web:
  meshcentral-backups:
```

### Using an `.env` File
Create a `.env` file:
```ini
# Environment variables
NODE_ENV=production
CONFIG_FILE=/opt/meshcentral/meshcentral-data/config.json
DYNAMIC_CONFIG=true

# MeshCentral Configuration
ALLOW_PLUGINS=false
ALLOW_NEW_ACCOUNTS=false
ALLOWED_ORIGIN=false
ARGS=
HOSTNAME=localhost
PORT=443
REDIR_PORT=80
IFRAME=false
LOCAL_SESSION_RECORDING=true
MINIFY=true
REGEN_SESSIONKEY=false
REVERSE_PROXY=
REVERSE_PROXY_TLS_PORT=
WEBRTC=false

# MongoDB Configuration
USE_MONGODB=false
MONGO_HOST=
MONGO_PORT=27017
MONGO_USERNAME=
MONGO_PASS=
MONGO_URL=

# PostgreSQL Configuration
USE_POSTGRESQL=false
PSQL_HOST=
PSQL_PORT=5432
PSQL_USER=
PSQL_PASS=
PSQL_DATABASE=

# MariaDB/MySQL Configuration
USE_MARIADB=false
MARIADB_HOST=
MARIADB_PORT=3306
MARIADB_USER=
MARIADB_PASS=
MARIADB_DATABASE=

# Build options
INCLUDE_MONGODB_TOOLS=false
INCLUDE_POSTGRESQL_TOOLS=false
INCLUDE_MARIADB_TOOLS=false
PREINSTALL_LIBS=false
```
Then run Docker Compose:
```sh
docker compose -f ./docker/compose.yaml --env-file .env up -d
```

# Custom healthchecks at runtime

If you want to add a custom healthcheck post-compilation/with precompiled images, then do the following:<br>
This all is based on [Docker documentation](https://docs.docker.com/reference/compose-file/services/).

Add the following lines to your compose.yaml:
```yaml
services:
  meshcentral:
    image: ghcr.io/ylianst/meshcentral:latest
    ...
    <the rest of the compose.yaml>
    ...
    
    healthcheck:
      test: ["CMD", "curl", "-k", "--fail", "https://localhost:443/health.ashx"]
      interval: 30s
      timeout: 5s
      start_period: 5s
      retries: 3
```

And if you ever change the port on which MeshCentral *INTERNALLY* runs on please also change the healthcheck either in your compose or self-compiled Dockerfile.<br>
Also relevant if you change scheme, such as HTTP to HTTPS or vice versa.

# MeshCentral Docker Build Process

This document explains the build process for the MeshCentral Docker image, along with details on various build arguments and how to use them.

## Build Arguments

The following build arguments are available for customizing the build process:

- **DISABLE_MINIFY**: Disable HTML/JS minification during the build.
- **DISABLE_TRANSLATE**: Disable translation of strings in MeshCentral.
- **INCLUDE_MONGODB_TOOLS**: Include MongoDB client and related tools.
- **INCLUDE_POSTGRESQL_TOOLS**: Include PostgreSQL client tools.
- **INCLUDE_MARIADB_TOOLS**: Include MariaDB/MySQL client tools.
- **PREINSTALL_LIBS**: Pre-install specific libraries like `ssh2`, `nodemailer`, etc.

### Build Commands with Arguments

Here are the shell commands to build the Docker image with different configurations.

#### 1. Build with Minify and Translate Disabled
If you want to disable both HTML/JS minification and translation during the build process, use the following command:
> While in the root git location.

```sh
docker build -f docker/Dockerfile --build-arg DISABLE_MINIFY=no --build-arg DISABLE_TRANSLATE=no -t meshcentral .
```
