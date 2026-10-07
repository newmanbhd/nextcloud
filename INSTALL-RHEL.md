# Installing CamVault on Red Hat Enterprise Linux 10

This guide takes you from a fresh RHEL 10 server to the camera website running. It takes about 15 minutes.

**About Docker on Red Hat:** RHEL doesn't include Docker. It includes **Podman**, Red Hat's replacement, which uses the same files and builds the same containers. You don't need to install Docker; the install script uses Podman for you.

Type every command below in a terminal on the server: log in with SSH, or open Terminal on the server's desktop. Lines that start with `sudo` ask for your password.

---

## Step 1: Install Git and download CamVault

Install Git:

```bash
sudo dnf install -y git
```

Download the files into `/opt/camvault`:

```bash
sudo git clone -b claude/cctv-ip-camera-web-lw6l0h https://github.com/newmanbhd/nextcloud.git /opt/camvault
```

If the repository is **private**, Git asks for a username and password:

- **Username:** your GitHub username
- **Password:** a GitHub **personal access token**, not your GitHub password. To create one, go to GitHub → your picture (top right) → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**. Give it read access to *Contents* on the `nextcloud` repository, and paste the token when Git asks for the password. Nothing shows on screen while you paste; that's normal.

<details>
<summary>Alternative: copy the files from your PC instead of using Git</summary>

1. On GitHub, open the repository, switch to the branch `claude/cctv-ip-camera-web-lw6l0h`, then click **Code → Download ZIP**.
2. Copy the ZIP to the server, for example with [WinSCP](https://winscp.net) on Windows, or with `scp nextcloud.zip user@server:/tmp/` from macOS or Linux.
3. On the server:
   ```bash
   sudo dnf install -y unzip
   sudo unzip /tmp/nextcloud*.zip -d /opt
   sudo mv /opt/nextcloud-* /opt/camvault
   ```
</details>

## Step 2 (optional): Choose where video is saved

Video uses a lot of space: roughly 40 GB per camera per day at 1080p. By default, recordings go to `/var/lib/camvault/recordings` on the system disk.

If you have a separate large disk, find where it is mounted:

```bash
df -h
```

Look in the **Mounted on** column for your big disk, for example `/mnt/storage`. You'll use that in Step 3.

## Step 3: Run the installer

```bash
cd /opt/camvault
```

Then run **one** of these:

```bash
# Save recordings on the system disk (default)
sudo ./install-rhel.sh

# OR: save recordings on another disk (change /mnt/storage/cctv to your path)
sudo RECORDINGS_DIR=/mnt/storage/cctv ./install-rhel.sh
```

The script:

1. Installs Podman
2. Builds the CamVault container. The first time, this downloads about 300 MB and takes a few minutes.
3. Creates the folders and a settings file, `/etc/camvault/camvault.env`, with a randomly generated password
4. Sets it up as a system service, so it starts automatically when the server boots and restarts if it crashes
5. Opens port 8080 in the firewall

At the end it prints something like:

```
==> CamVault is running
  Open:      http://192.168.1.20:8080
  Username:  admin
  Password:  k3Jd9xQ2mPz7Lw1aB5
```

**Write the password down.** It's only shown once. You can always change it; see below.

## Step 4: Set your time zone

Recording file names use the time zone in the settings file. Check that it's yours:

```bash
sudo nano /etc/camvault/camvault.env
```

Find the `TZ=` line and set it to your time zone, for example `TZ=Australia/Sydney`. In nano, save with **Ctrl+O** then **Enter**, and exit with **Ctrl+X**. Then restart CamVault:

```bash
sudo systemctl restart camvault
```

## Step 5: Open the website and add your cameras

1. On any PC or phone on the same network, open the address the installer printed, e.g. `http://192.168.1.20:8080`.
2. Sign in as `admin` with the password.
3. Add your cameras:
   - **Easiest, via ONVIF:** click **Cameras → Add via ONVIF**, enter the device's IP address, ONVIF port (usually 80) and login, then click **Find streams**. Tick the channels you want and click **Add selected**. ONVIF may need switching on in the device's network settings first.
   - **DVR / NVR:** click **Cameras → Add DVR / NVR**. Pick the brand, enter the DVR's IP address, its login and the number of channels, click **Test channel**, then **Add channels**. Every channel is added in one go.
   - **Single IP camera:** click **Cameras → Add camera**, enter a name and the camera's stream address (see the table in [README.md](README.md#ip-cameras)) plus its username and password, click **Test connection**, then **Save**.
4. Go to **Live**. Within about 10 seconds the camera's status turns green ("Live") and the video appears.

If a camera says **Reconnecting…**, the Cameras page shows the error. It's usually a wrong stream address, username or password.

---

## Everyday tasks

| To... | Run |
|---|---|
| Check it's running | `sudo systemctl status camvault` |
| See the log (errors etc.) | `sudo journalctl -u camvault -n 50` |
| Stop / start / restart | `sudo systemctl stop camvault` (or `start`, `restart`) |
| Change password or retention | `sudo nano /etc/camvault/camvault.env`, then `sudo systemctl restart camvault` |
| See the recordings on disk | `ls /var/lib/camvault/recordings` (or your own recordings folder) |

### Updating to a newer version

```bash
cd /opt/camvault
sudo git pull
sudo ./install-rhel.sh            # add RECORDINGS_DIR=... again if you used it in Step 3
```

Your cameras, password and recordings are kept.

### Analog CCTV capture card

If you use a capture card or USB video grabber instead of a DVR, edit `/etc/containers/systemd/camvault.container`. Remove the `#` in front of `AddDevice=/dev/video0`, then run:

```bash
sudo systemctl daemon-reload && sudo systemctl restart camvault
```

Note that running the installer again overwrites this file, so redo this edit after each update.

### Uninstalling

```bash
sudo systemctl stop camvault
sudo rm /etc/containers/systemd/camvault.container
sudo systemctl daemon-reload
sudo podman rmi localhost/camvault:latest
# Only if you also want to delete settings and ALL recordings:
# sudo rm -rf /etc/camvault /var/lib/camvault
```

---

## Troubleshooting

**The page doesn't load from another PC.**
Check that the service is running (`sudo systemctl status camvault`) and that the port is open (`sudo firewall-cmd --list-ports` should show `8080/tcp`). Also check that you're using the server's IP address on the same network.

**"CamVault did not start".**
Run `sudo journalctl -u camvault -n 50` and look at the last lines.

**Video shows a black tile but the status is green.**
The camera is probably sending H.265. Either change the camera's video encoding to H.264 in its own settings page, or edit the camera in CamVault and tick **Transcode to H.264**.

**"Permission denied" errors about the recordings folder.**
That's SELinux, Red Hat's extra security layer. The installer handles it for folders on local disks. Network shares (NFS or SMB) need extra SELinux setup, so a local or USB-attached disk is the simplest choice for recordings.

**Viewing your cameras away from home.**
Don't open port 8080 on your internet router. Install a VPN such as [Tailscale](https://tailscale.com) on the server and on your phone instead. It's free for personal use, and you then open the same address securely from anywhere.
