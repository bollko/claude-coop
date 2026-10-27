# claude-coop

A Claude Code mod for sharing one live chat with friends. Everyone prompts their own Claude on their own account, and everyone sees every turn in a shared pane.

- Your prompts and your Claude's replies show on the left, your peers' on the right.
- "Jason is typing" shows with Jason's avatar and animated dots when a peer types.
- Avatars are your GitHub picture, shrunk to 16×16 pixels: found automatically if the `gh` CLI is signed in, or set with `/coop avatar <github-username>` (`/coop avatar none` shows your initial instead). Fetching a picture needs Windows for now; everyone sees pictures on any system.
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

## Host a room (free, no server needed)

```
/coop host <your-name> [repo-url]
```

Your PC runs the relay, and a free tunnel through [localhost.run](https://localhost.run) gives it a public address, using the `ssh` that Windows 10/11, macOS and Linux already have. No account, port forwarding or Tailscale. The Co-op pane shows an invite with a **Copy invite** button; send it to your friends, who put their own name at the end:

```
/coop join https://abc123.lhr.life room-x7k2pq <secret> Jason
```

Hosting needs [Node.js](https://nodejs.org). The room lasts while your Claude session runs, and each `/coop host` gives a new address and secret.

## Run your own relay

The relay is one Node file with no dependencies (Node 18 or later). Run it on any server you have:

```bash
git clone https://github.com/bollko/claude-coop
node claude-coop/relay/server.mjs
```

It listens on port 8787 (set `PORT` to change it). Put HTTPS in front of it (Caddy, nginx) and everyone joins with your address:

```
/coop join <relay-url> <room> <secret> <your-name>
```

The first person to join a room creates it; everyone else uses the same room name and secret. Rooms live in memory: restarting the relay clears them.

## Privacy

Messages, screenshot previews and the room's repo URL are encrypted with a key made from the room name and secret before they leave your PC. The relay, and any tunnel in front of it, sees only ciphertext, plus names, who is typing and who holds the edit lock. It never receives the secret itself. A weak secret can be guessed offline, so use a long random one (`/coop host` makes one for you).

- `/coop` opens the pane again.
- `/coop leave` leaves the room (and stops hosting).

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
- Everyone in a room needs this version (0.3.0) or later: older versions don't encrypt. Screenshot previews and avatars are drawn from small pixel grids.
- On mobile the pane has no message box; use the main prompt box.
