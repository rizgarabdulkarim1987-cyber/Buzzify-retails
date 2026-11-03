# Auto deploy (GitHub to the VPS)

A merge to `main` runs `.github/workflows/deploy.yml`. It opens an SSH session to the VPS with a key
that can only run `/docker/deploy.sh retail`, which tags the current image as `:before`, rebuilds from
GitHub `#main` and restarts the `retail` compose project.

## One-time setup on the VPS

1. Save `docs/deploy/vps-deploy.sh` as `/docker/deploy.sh` and `chmod +x /docker/deploy.sh`.
2. Create a key used only for this: `ssh-keygen -t ed25519 -f ~/.ssh/gh_deploy -N "" -C gh-deploy`.
3. Add its public half to `~/.ssh/authorized_keys` locked to the script:
   `restrict,command="/docker/deploy.sh" <contents of ~/.ssh/gh_deploy.pub>`.
4. GitHub, Settings, Secrets and variables, Actions, repository secrets (values are pasted by the owner, never committed):
   `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (the private half), `VPS_KNOWN_HOSTS`
   (`echo "<ip> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"` run on the VPS).
5. GitHub, Settings, Environments: create `production`.

## Rolling back

On the VPS: `docker tag retail-retail:before retail-retail:latest && cd /docker/retail && docker compose up -d --no-build`.
