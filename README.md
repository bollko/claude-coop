# claude-coop

A Claude Code mod for sharing one live chat with friends. Everyone prompts their own Claude on their own account, and everyone sees every turn in a shared pane.

- Your prompts and your Claude's replies show on the left, your peers' on the right.
- "Jason is typing..." shows when a peer types.
- Before each of your prompts, your Claude is told what your peers' Claudes did since your last turn. Updates over 4,000 characters are condensed by Haiku first, a small extra call on your account.
- A message box in the pane lets you talk to your Claude from there. Copy a screenshot and press "📎 Paste screenshot", or press "📄 Attach files" to pick files; they go with your next message, with or without text. Peers see the names and screenshot previews. (Windows works out of the box; macOS needs nothing or `pngpaste`; Linux needs `wl-paste` or `xclip`, and `zenity` for the file picker.)

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install claude-coop --marketplace bollko/claude-coop
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter).

From a shell:

```bash
claude plugin install claude-coop --marketplace bollko/claude-coop
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `bollko/claude-coop`, then Add plugin.

## Run a relay

One person runs the relay, a small Node server with no dependencies (Node 18 or later):

```bash
git clone https://github.com/bollko/claude-coop
node claude-coop/relay/server.mjs
```

It listens on port 8787 (set `PORT` to change it). Others need to reach that machine, for example over Tailscale, or behind an HTTPS tunnel such as Cloudflare Tunnel. Plain HTTP sends the room secret unencrypted, so use it only on a network you trust.

Rooms live in memory: restarting the relay clears them.

## Join a room

```
/coop join <relay-url> <room> <secret> <your-name>
```

For example `/coop join http://192.168.1.20:8787 myroom tacos42 Jason`. The first person to join a room creates it and sets its secret; everyone else uses the same room name and secret. Pick a made-up secret, not a real password.

- `/coop` opens the pane again.
- `/coop leave` leaves the room.

## Shared files

Give the room a git repo, and everyone's Claude works on the same files:

```
/coop join <relay-url> <room> <secret> <your-name> <repo-url>
```

or later, `/coop repo <repo-url>` (`/coop repo none` clears it). Everyone else picks the repo up when they join.

- Open Claude in a clone of the repo. The mod moves that folder to a branch for the room, `coop/<room>`, and never touches `main`.
- Before each prompt, the mod takes the room's edit lock and pulls peers' changes. After the turn, it commits what changed and pushes it to the room branch, then releases the lock.
- While someone's Claude holds the lock, the pane shows "🔒 Jason's Claude is editing the shared files" and other prompts wait.
- If two people's changes clash, the mod stops and tells you; resolve with `git pull` and push yourself.
- `/coop ship` asks your Claude to run the project's tests on the room branch and, only if they pass, open a pull request into `main`.

## Limits

- The pane polls the relay once a second.
- Each person's Claude edits files on their own machine; share a project through git yourselves.
- On mobile the pane has no message box; use the main prompt box.
