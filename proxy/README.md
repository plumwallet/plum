# Solana RPC proxy

Anyone can unpack a browser extension, so a paid RPC key built into plum would be a key handed to everyone. plum asks
`https://plum.fun/rpc` instead, and `rpc-proxy.mjs` (one file, no dependencies) passes those calls on to the paid RPC.
The paid RPC's URL and key live only in the server's environment and never come back out: not in an answer, an error
or a log line.

## What it lets through

- **One JSON-RPC call per request**, no batches, as `application/json`, at most 32 KB.
- **Only the eleven methods plum calls**, each with its params in the shape Solana takes them: `getAccountInfo`,
  `getBalance`, `getBlockHeight`, `getLatestBlockhash`, `getMultipleAccounts` (100 accounts at most),
  `getRecentPrioritizationFees`, `getSignatureStatuses`, `getSignaturesForAddress`, `getTokenAccountsByOwner`,
  `sendTransaction` and `simulateTransaction` (a transaction of 1232 bytes at most). `test/rpc-proxy.test.mjs` checks
  this list against every call in `src/background/`, so the wallet and the proxy can't drift apart.
- **Only from a browser extension**: an `Origin` of `moz-extension://<uuid>` or `chrome-extension://<id>`, which no
  web page can send. Pages and scripts get 403, so no site can use plum's RPC as its own through its visitors' browsers.
- **The call is written afresh** before it goes on: none of the caller's headers, address or bytes go with it, so the
  paid RPC never learns who asked.
- **Answers stream back** as they come, cut off past 12 MB or if one ever held the key.

## Limits

Each address (an IPv6 /64 counts as one; Cloudflare's `cf-connecting-ip`, trusted only from cloudflared on the same
machine) gets 6 calls a second with bursts of 120 (importing a recovery phrase checks ~60 wallets in a row), 25,000 a
day, 1 send a second (bursts of 30), 2 MB a second of answers (bursts of 64 MB) and 12 calls at a time. Everyone together
gets 30 calls a second (bursts of 150), 300,000 a day, 5 sends a second and 64 calls at a time, so the paid plan's bill
has a ceiling. Over a limit is a 429 with `Retry-After`, which plum retries and then explains. Every limit can be set
in the environment by name (`IP_RATE`, `ALL_DAILY`... see `LIMITS` in `rpc-proxy.mjs`). Set the `ALL_` ones under the
paid plan's own limits, less whatever else uses the same key.

Nothing about who asked what is kept. The log gets totals every 15 minutes (calls per method, megabytes out, what was
turned down and why) and a line when the paid RPC refuses the key, rate-limits plum or is down.

## Run it

```bash
UPSTREAM_RPC='https://mainnet.helius-rpc.com/?api-key=...' node proxy/rpc-proxy.mjs
```

It listens on `127.0.0.1:8792` (`HOST`, `PORT`). `GET /rpc/health` answers `{"ok":true}` without calling the paid RPC.
To try plum against it, build with `node build.mjs --rpc http://127.0.0.1:8792/rpc`.

## On the server

1. `rpc-proxy.mjs` goes to `/srv/plum-rpc/` (root-owned, readable: it's public code).
2. `/etc/plum-rpc/plum-rpc.env`, root-only (`chmod 600`), holds `UPSTREAM_RPC=<the paid RPC URL>` and any limits.
3. `plum-rpc.service` goes to `/etc/systemd/system/`: it runs as a user systemd makes up for it, with the filesystem
   read-only, and only systemd reads the env file. Then `systemctl enable --now plum-rpc`.
4. cloudflared sends `plum.fun/rpc` to it. In the tunnel's `config.yml`, above the rule for the rest of `plum.fun`:

   ```yaml
   - hostname: plum.fun
     path: ^/rpc(/|$)
     service: http://127.0.0.1:8792
   ```

   Check with `cloudflared tunnel --config <config.yml> ingress rule https://plum.fun/rpc`, then restart the tunnel.
5. From anywhere: `curl https://plum.fun/rpc/health`, and a real call the way plum makes it:

   ```bash
   curl -s https://plum.fun/rpc -H 'content-type: application/json' -H 'origin: moz-extension://00000000-0000-4000-8000-000000000000' -d '{"jsonrpc":"2.0","id":1,"method":"getBlockHeight"}'
   ```

`npm run sign` checks that this answers before it signs a copy for anyone, since that copy reads mainnet through it.
