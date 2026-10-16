# cmd-mod-jev-nudge

https://github.com/user-attachments/assets/c2265d14-2012-46e2-94fb-f7b1174c00e9

[Demo video on 𝕏](https://x.com/MrAhmadAwais/status/2102456912486989945)

Agents stop too early. They do one step, say "next I'll do X", and hand the prompt back.

This [Command Code](https://commandcode.ai) mod asks [Jev](https://typesafe.ai) at every stop:
would a nudge help? Yes, and the agent keeps going. It won't nudge when the agent is waiting on
you, or when the last nudge got nothing done.

## Install

Requires [jevd](#jevd) (the warm local Jev relay this fork talks to) on the same machine —
check it with `curl -s http://127.0.0.1:4377/health`.

```bash
cmd mods add <your-fork>         # add -g for all projects
```

No `cmd login` needed on the default route: jevd holds the provider keys and every call it
routes is billed through the machine's own provider ladder. If Jev fails, the run stops
as normal.

### jevd

This fork routes the mod's Jev call through **jevd**, the owner's warm local relay
(`http://127.0.0.1:4377/v1/systemone`), instead of hitting TypeSafe or Command Code
directly. jevd keeps provider connections open and runs a provider ladder per call, so a
call answers faster and survives a dead provider. No key is sent; jevd has its own.

Not on the machine with jevd? Point the mod at a direct route and bring a key:

```bash
cmd --mod . --mod-option jev-nudge-base-url=https://api.commandcode.ai/provider/v1 \
                --mod-option jev-nudge-model=typesafe/jev   # + CMD_API_KEY / cmd login
```

## See it

```
say hi in five languages. ONE hi per reply, then stop and say how many done. after the fifth say "all done".
```

```
you   ▸ say hi in five languages ...

agent ▸ Hola! 1 of 5 done.
  jev nudge 1: unfinished work found (78%), continuing
agent ▸ Bonjour! 2 of 5 done.
  jev nudge 2: unfinished work found (74%), continuing
agent ▸ Ciao! 3 of 5 done.
  jev nudge 3 ...
agent ▸ Hallo! 4 of 5 done.
  jev nudge 4 ...
agent ▸ Konnichiwa! all done.
                                  ← Jev 5%, no nudge, run ends
you   ▸ _
```

You type once and get five replies. Add "then wait for my go-ahead" to the prompt and it stops after
one, because the agent is now waiting on you.

## How it works

```
agent stops
   │
   ▼
POST jevd → 127.0.0.1:4377/v1/systemone  (provider ladder)
    nudge     would a nudge help right now?        p
    waiting   needs you: permission, info, choice? p
    progress  did the last nudge get anywhere?     p   (2nd nudge on)
    │
    ▼
waiting ≥ .5 · progress < .5 · nudge < .5 · error  →  stop
otherwise                                          →  nudge, keep going
```

Command Code allows at most 8 nudges per user turn.

## Flags

`--mod-option name=value`

| Flag | Default | Meaning |
|---|---|---|
| `jev-nudge-threshold` | `0.5` | Min probability to nudge |
| `jev-nudge-max` | none | Max nudges per run, `0` = off |
| `jev-nudge-verbose` | `false` | Show skipped nudges too |
| `jev-nudge-base-url` | `http://127.0.0.1:4377` | SystemOne base (jevd). Non-loopback = direct route, needs a key |
| `jev-nudge-model` | none | Model id; absent lets jevd's ladder pick (`typesafe/jev` pins Command Code) |

`DEBUG=true` logs every decision to stderr.

The 0.5 threshold is measured. Jev says 0.5 to 0.8 with work left and under 0.1 when done.

## Develop

```bash
git clone https://github.com/CommandCodeAI/cmd-mod-jev-nudge.git
cd cmd-mod-jev-nudge && pnpm install
cmd --mod .       # run it
pnpm test
```

Offline, run `node scripts/fake-jev.mjs` and add
`--mod-option jev-nudge-base-url=http://127.0.0.1:4711`. It logs requests to `jev-log.jsonl`.
