# Installing MeshCentral with FreeRDP Web-RDP

This guide sets up the server from a ready-made Docker image. You do not need to download or build the source code.
It takes about 10 minutes.

## What you need

* A Linux server (x86-64 or 64-bit ARM) with [Docker](https://docs.docker.com/engine/install/) installed.
* The server's address: an IP address (for example `192.168.1.10`) or a domain name (for example `mesh.example.com`).
* Two free TCP ports on the server: one for HTTPS (443 by default) and one for HTTP (80 by default).
  If something else already uses them, pick other ports, such as 1443 and 180.

Check that Docker works:

```bash
docker --version
docker compose version
```

## 1. Download two files

```bash
mkdir meshcentral && cd meshcentral
curl -fsSLO https://raw.githubusercontent.com/kxd231/MeshCentral/dev/docker/compose.new.yaml
curl -fsSL -o config.json https://raw.githubusercontent.com/kxd231/MeshCentral/dev/docker/config.example.json
```

`compose.new.yaml` tells Docker what to run. `config.json` is the MeshCentral settings file.

## 2. Edit config.json

Open it in an editor, for example `nano config.json`, and change three things:

1. **`"cert"`**: replace `meshcentral.example.com` with your server's address. Devices and browsers will use it to
   reach the server.
2. **`"port"` and `"redirPort"`**: leave 443 and 80, or set the ports you chose.
3. **The session key.** Generate a random key:

   ```bash
   openssl rand -hex 32
   ```

   Find the line `"_sessionKey": "Remove the underscore ..."`, remove the underscore from `_sessionKey` and put the
   generated key in quotes:

   ```json
   "sessionKey": "3f9c...your generated key...a1",
   ```

   Without it, everyone is logged out each time the server restarts.

Keys starting with `_` are switched off. You can leave the other ones as they are.

## 3. Only if you changed the ports

Create a file named `.env` in the same folder with the same ports:

```bash
printf 'MC_HTTPS_PORT=1443\nMC_HTTP_PORT=180\n' > .env
```

The ports in `.env` and in `config.json` must be the same.

## 4. Start the server

```bash
docker compose -f compose.new.yaml pull
docker compose -f compose.new.yaml up -d
```

The first start takes a minute or two: the server creates its certificates and downloads the agent installers.
To watch it:

```bash
docker logs -f meshcentral
```

When you see `MeshCentral HTTPS server running`, press Ctrl+C (the server keeps running).

## 5. Create the administrator account

Open `https://<your server address>` in a browser (add `:1443` if you changed the port).

The browser warns about the certificate. This is expected: the server uses its own self-signed certificate.
Accept the warning to continue.

Click **Create one** under the login form. **The first account becomes the administrator**; after that, the page no
longer offers to create accounts.

## 6. Add a computer

1. In MeshCentral, create a device group (**Add Device Group**, type "Manage using a software agent").
2. Click **Add Agent** in the group, download the installer for the computer's system and run it on that computer.
3. After a moment the computer appears in the group.

## 7. Connect with Remote Desktop (RDP)

1. On the Windows computer, turn on Remote Desktop: Settings → System → Remote Desktop.
2. In MeshCentral, open the computer, go to the **Desktop** tab and click **RDP Connect**.
3. Enter the Windows user name and password. Tick **Remember credentials** to skip this next time.

Options are under **Settings** on the Desktop tab, in the RDP section:

* **Display Size**: the resolution of the remote session.
* **Graphics**: `GFX + H.264` works best in most cases. `GFX` gives sharper text on a fast network. Use `Legacy` if
  a computer has trouble with the other two.
* **Image Quality**: lower it on a slow connection.
* Checkboxes such as **Disable Wallpaper** make the session faster.

### Linux computers

Use **RDP Connect** on the Desktop tab, as for Windows. The Linux computer needs an RDP server:

* **GNOME** has one built in: Settings → System → Remote Desktop. It works only with **Graphics** set to `GFX` or
  `GFX + H.264` (not `Legacy`).
  * **Remote Login** (port 3389) shows the GNOME login screen. In the MeshCentral form enter the user name and
    password set in *Remote Login* in GNOME Settings, not your Linux account. Then log in to Linux on the login
    screen that appears.
  * **Desktop Sharing** shows your already logged-in desktop. When Remote Login is also on, it moves to port 3390.
    To connect to it, right-click the **Web-RDP** link on the **General** tab, choose **Alternate Port** and enter
    3390 (the port is saved for this computer; enter 3389 to go back). Use the *Desktop Sharing* credentials.
* Other desktops can use **xrdp** (`sudo apt install xrdp`).

## Everyday tasks

**Update to the newest version:**

```bash
docker compose -f compose.new.yaml pull
docker compose -f compose.new.yaml up -d
```

**Change settings:** edit `config.json`, then `docker compose -f compose.new.yaml restart`.

**Stop or start:** `docker compose -f compose.new.yaml stop` / `start`.

**Where your data is:** in Docker volumes (accounts, devices, certificates, backups). Updates and
restarts keep them. MeshCentral makes a backup every day and keeps the last 14 days.

> **Warning:** `docker compose down -v` deletes the volumes, and with them all accounts, devices and certificates.

## Problems

**The page does not open.** Check that the container runs (`docker ps`), that the ports in `config.json` and `.env`
match, and that the server firewall allows them.

**Agents do not connect.** The address in `"cert"` must be reachable from the computers with the agent. Agents
installed before you changed the address or port must be installed again.

**RDP shows an error.** "Authentication failed" means a wrong user name or password. "Unable to connect" usually
means Remote Desktop is off on the computer or blocked by its firewall. For details, add `"debug": "relay",` in the
`settings` section of `config.json`, restart, try again and look at `docker logs meshcentral`.

## More

* All Docker options, building the image yourself, custom agent builds: [docker/README.md](docker/README.md)
* How the RDP helper works and how to build it without Docker: [docs/docs/meshcentral/webrdp.md](docs/docs/meshcentral/webrdp.md)
* General MeshCentral documentation: <https://meshcentral.com/docs/>
