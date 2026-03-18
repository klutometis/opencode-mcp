# Tunnel Hardening Plan

## Context

At the soccer field: tunnel died, no reconnection, no logs, no indication
anything was wrong. The `set -e` bug was one cause (fixed), but the tunnel
loop needs more resilience.

autossh was considered but rejected due to impedance mismatch with
`gcloud compute ssh` (not plain `ssh`). Would lose gcloud auth features,
need complex glue code, and add a dependency.

Instead: harden the existing loop with three targeted improvements.

## Changes

### 1. Exponential backoff with jitter

Instead of fixed `sleep 5`, back off: 5s, 10s, 20s, 40s, cap at 60s.
Reset to 5s on successful tunnel connection (i.e., tunnel stayed up for
more than 30 seconds before dying).

```
backoff=5
while true; do
  start_time=$(date +%s)
  ssh -N -R ... || exit_code=$?

  elapsed=$(( $(date +%s) - start_time ))
  if (( elapsed > 30 )); then
    # Tunnel was up for a while — reset backoff
    backoff=5
  else
    # Rapid failure — increase backoff
    backoff=$(( backoff * 2 ))
    (( backoff > 60 )) && backoff=60
  fi

  # Add jitter (0-5s) to avoid thundering herd
  jitter=$(( RANDOM % 5 ))
  sleep $(( backoff + jitter ))
done
```

### 2. Health probe from relay side

After the tunnel connects, fork a background health checker that
periodically probes the opencode instance THROUGH the tunnel from the
relay side. This catches TCP half-open connections (the main thing
autossh's monitoring port detects that ServerAliveInterval doesn't).

```
health_check_loop() {
  while true; do
    sleep 60
    # Probe opencode through the tunnel, from the relay
    if ! ${RELAY_SSH_CMD} "curl -sf --max-time 10 http://localhost:${REMOTE_PORT}/global/health" &>/dev/null; then
      log "Health check failed — tunnel may be dead"
      kill $SSH_PID 2>/dev/null  # force reconnect
      break
    fi
    log "Health check OK"
  done
}
```

Runs alongside the SSH tunnel. If the probe fails, it kills the SSH
process, which causes the tunnel loop to reconnect.

Interval: 60 seconds. Timeout: 10 seconds. So worst case, a dead tunnel
is detected in ~70 seconds.

Note: each health check is a gcloud SSH invocation (slow, ~8s). Could be
optimized later with a persistent connection or a relay-side daemon. But
for now, one gcloud call per minute is acceptable.

### 3. Better logging on all failure paths

Every exit path in the tunnel loop should log:
- SSH exit code and what it means (255 = connection error, etc.)
- Whether reconnecting or giving up
- Current backoff delay
- Health check results (OK / failed)
- Timestamp on everything (already done)

## What these changes catch

| Failure mode | Detection | Recovery |
|-------------|-----------|----------|
| Network blip (WiFi switch, etc.) | ServerAliveInterval (~90s) | Reconnect with backoff |
| Laptop sleep/wake | SSH dies on resume | Reconnect with backoff |
| Relay reboot | SSH connection refused | Reconnect with backoff |
| TCP half-open (tunnel looks alive but isn't forwarding) | Health probe (~70s) | Kill SSH, reconnect |
| Port conflict on reconnect | SSH exit 255 | Try next port |
| Rapid repeated failures | Exponential backoff | Prevents hammering relay |

## Files to change

- `scripts/opencode-connected` — tunnel_loop function

## Not changing

- Registration logic (works fine)
- Local port selection (works fine)
- Banner / logging infrastructure (works fine)
- The gcloud SSH command (no autossh)
