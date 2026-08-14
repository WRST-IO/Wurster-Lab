---
title: Wurster Web
group: Runtime
groupOrder: 3
order: 3
---

# Wurster Web

Wurster Web is the browser-hosted Wurster runtime family. Its distributable surface is intentionally dependency-free:

```text
wurster.min.js
wurster-sw.js
wurster-embed.js
wurster-embed-host.html
```

The core runtime uses a service worker to give each Wurst a virtual application resource surface while the visible Wurst runs in a sandboxed iframe. Normal relative HTML/CSS/JavaScript URLs therefore keep working inside a Wurst.

## 0.32.0 runtime surface

Wurster Web can:

- open native WRST v7 from a user-selected `File`/`Blob`;
- open a remote `.wurst` or `.wrst` through pinned HTTP byte ranges;
- inspect manifest and immutable resource metadata without downloading the complete remote file;
- verify immutable resource chunk hashes;
- verify an Ed25519 Wurst package signature when the browser exposes Ed25519 through Web Crypto;
- run public application resources in a sandboxed iframe;
- unlock **partial** WurstKey application protection in-browser;
- unlock **fully sealed** WurstKey applications, including their encrypted private application map;
- keep the WurstKey outside application JavaScript and application DOM;
- read plain WurstFS metadata and file ranges;
- maintain a writable browser-session WurstFS overlay backed by chunk records rather than whole-file renderer buffers;
- provide `wurst.fs.*` CRUD, bounded range reads and chunked write sessions;
- serve WurstFS media through range-capable virtual URLs;
- export the current overlay as a standalone WRST v7 snapshot;
- embed a Wurst through the `<wurst-embed>` Custom Element without requiring the embedding site to install a Wurster service worker on its own origin.

A remote Wurst remains read-only at its origin. Browser writes belong to the current Wurster session until the user exports a new Wurst snapshot.

## The simple embed

The CDN-facing integration is deliberately image-like:

```html
<script type="module" src="https://cdn.example/wurster/wurster-embed.js"></script>

<wurst-embed src="./media/example.wurst"></wurst-embed>
```

`wurst-embed` is a standards-based Custom Element. Custom Element names require a hyphen, which is why the element is not simply `<wurst>`.

Size it with normal CSS:

```css
wurst-embed {
  width: 720px;
  height: 480px;
}
```

### Optional embedded WurstKey

A developer may intentionally publish or share a key together with an embed:

```html
<wurst-embed
  src="./demos/client-preview.wurst"
  wurstkey="wurstkey-v1-....">
</wurst-embed>
```

This is useful for demos, controlled previews, puzzles or any case where encryption is desired as packaging/access behavior but the embedding page is intentionally allowed to know the key.

The `wurstkey` attribute is part of the host page DOM. Any script trusted by that page can read it. Do not use the attribute when the embedding page itself must not know the secret.

If the attribute is omitted:

- a fully sealed Wurst shows Wurster-owned unlock UI before application HTML is executed;
- a partial Wurst loads its public `src/` shell immediately. If the shell later requests a protected resource while locked, Wurster Web pauses that resource request and presents its own WurstKey UI. The app can also request the same unlock explicitly through `<wurster-auth type="wurstkey">`.

The key is used by the Wurster Web host and is never exposed as `window.wurst` data to the Wurst application.

## Why the embed does not install a service worker on your site

A normal service worker belongs to the origin and scope that registered it. A third-party CDN script should not ask every embedding site to install a root-level Wurster service worker.

`<wurst-embed>` therefore creates an isolated Wurster host iframe on the Wurster distribution origin. The parent page reads the configured Wurst source and answers bounded byte-range requests over a `MessageChannel`:

```text
embedding page
    |
    | <wurst-embed src="./demo.wurst">
    v
Wurster embed element
    |
    | bounded byte ranges
    v
isolated Wurster host iframe
    |
    +-- Wurster Web
    +-- Wurster service worker on the host origin
    +-- sandboxed Wurst application iframe
```

If the Wurst server supports HTTP Range, the parent streams only the required ranges. If the server ignores Range but permits the fetch, the embed falls back to a local Blob source.

Cross-origin Wurst URLs still follow ordinary browser CORS rules.

## Direct JavaScript API

Applications that host Wurster Web themselves may still use the lower-level API:

```html
<script type="module">
  import { WursterWeb } from "/wurster.min.js";

  const session = await WursterWeb.open(fileOrUrl, {
    serviceWorkerUrl: "/wurster-sw.js",
    serviceWorkerScope: "/"
  });

  await session.mount("#wurst-stage");
</script>
```

A WurstKey can be supplied programmatically too:

```js
const session = await WursterWeb.open(fileOrUrl, { wurstKey });
```

## Partial application protection

Partial application protection already exists in WRST v7 and MeatGrinder:

```text
src/       public application shell
sealed/    developer-owned WurstKey content
```

The public entry runs without a WurstKey. If it later exposes:

```html
<wurster-auth type="wurstkey" purpose="application"></wurster-auth>
```

This explicit control is optional. A fetch/navigation for a protected application resource also triggers the same Wurster-owned unlock UI automatically. The pending resource continues after a valid key; choosing **Not now** leaves the public shell running and rejects only that protected request.

Wurster Web opens the actual key-entry surface outside the Wurst application frame. On success the encrypted application resources become readable through their normal logical paths.

If a protected resource is requested before the application has unlocked, the runtime reports the resource as locked rather than returning ciphertext or silently weakening protection.

## Fully sealed applications

A fully sealed Wurst hides its original application entry and logical application paths behind an encrypted `wurst/sealed-app-map-1` map. Wurster Web now opens that map with the same portable WurstKey/AES-256-GCM semantics as Desktop Wurster and only then starts the real application entry.

No application HTML executes before a valid WurstKey is available.

## URL semantics

A Wurst is still a web application internally. Static application resources use normal relative URLs:

```html
<script src="./app.js"></script>
<link rel="stylesheet" href="./style.css">
<img src="./assets/pig.png">
```

For mutable `/data` resources the Wurst asks the runtime:

```js
video.src = wurst.fs.url('/data/videos/flight.mp4');
```

The returned URL is runtime-owned and opaque.

## WurstFS on the web

The web runtime does not pretend it can silently overwrite a remote server object or an arbitrary local file. Instead it exposes a writable session overlay:

```text
remote/local Wurst base     read
browser session overlay     read/write
snapshot export             new standalone .wurst
```

IndexedDB may be used as an implementation backing store, but it is not part of the portable Wurst persistence contract.

## Wurster online viewer

The Wurster site consumes the same generated web-runtime distribution and exposes `/viewer/` as a general browser Wurst viewer. A user can drag a `.wurst` or `.wrst` file onto the page and run it without installing Desktop Wurster.

The viewer is intentionally built on `<wurst-embed>` rather than a separate private runtime. This keeps the public embed path and the official viewer on the same implementation.

## Remaining browser parity work

0.32.0 completes WurstKey application execution, but not every Desktop trust/auth feature is browser-equivalent yet.

Still before 1.0:

- WurstFS v2 realm parity: history-free ordinary/personal realms, compaction behavior, Wurster Identity signing, X25519 shared-reader key-wraps, sealed realm catalogs/data and shared integrity/fork semantics;
- personal/shared WurstFS realm crypto, trusted identity handoff and protected snapshot writes;
- the cryptographic return leg for Desktop Wurster identity/auth handoff;
- browser presentation of the full publisher DNS/Authority trust chain and `<wurst-identity>` parity;
- Undercover PNG source adaptation in Wurster Web;
- complete PigLink host/event conformance and browser-platform capability audit.

The runtime must report unsupported behavior honestly rather than pretending that browser and desktop capabilities are identical.

## WRST.IO Authority trust

The Web distribution contains the same pinned public WRST.IO Root and Root-signed trust bundle as Desktop Wurster. `wurst/publisher-certificate-3` verified claims are checked locally through Root → issuer → publisher after the package signature verifies. This does not require a browser request to `authority.wrst.io`; live DNS identity remains a separate optional trust route.
