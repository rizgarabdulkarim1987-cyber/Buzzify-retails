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

## Product addresses (Caddy)

DNS for `*.buzzify.tech` already points at the VPS. The three product addresses go to the same `retail`
container as the shared address; Caddy gets and renews their certificates by itself on the first request.

1. Add one site block to the Caddyfile, next to the existing Retails block. Use the same upstream as that
   block (the `reverse_proxy` line); `retail:3000` below is an example:

```caddyfile
supermarket.buzzify.tech, electronics.buzzify.tech, clothing.buzzify.tech {
	encode zstd gzip
	# Caddy passes the browser's Host through unchanged; Retails trusts it only for the hosts in PACK_HOSTS.
	reverse_proxy retail:3000
}
```

   Do not add `header_up Host ...` or a rewrite of Host: Retails reads the product from `Host` and never from
   `X-Forwarded-Host`.

2. Check and reload Caddy (container name as on the VPS):
   `docker exec <caddy> caddy validate --config /etc/caddy/Caddyfile` then
   `docker exec <caddy> caddy reload --config /etc/caddy/Caddyfile`.
3. In `/docker/retail` add to the app environment (the same place as `APP_URL`):
   `PACK_HOSTS=supermarket.buzzify.tech=SUPERMARKET,electronics.buzzify.tech=ELECTRONICS,clothing.buzzify.tech=CLOTHING`
   then `docker compose up -d`. A malformed value stops the container at start: `docker compose logs retail`
   names `PACK_HOSTS`.
4. Check: each address answers over https and its sign-in page names its product
   (`curl -sI https://supermarket.buzzify.tech/login` gives 200).

Rolling back: remove `PACK_HOSTS` (the shared address keeps working for every product) and the site block.
