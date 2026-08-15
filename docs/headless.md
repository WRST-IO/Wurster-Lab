---
title: Headless Wursts
group: Building Wursts
groupOrder: 3
order: 4
---
# Headless Wursts

A Wurst may expose PigLink behavior that works without a visible DOM. This is the machine end of the same portable Wurst, not a second application format.

A Child must declare `piglink.headless: true` before `wurst.piglet.connect()` / `invoke()` can use it without a View.

## Developer harness

Wurster Lab 0.32.4 includes a browserless harness for development, CI and automation:

```bash
wurster-headless describe app.wurst
wurster-headless invoke app.wurst math.add --input '{"a":20,"b":22}'
wurster-headless test app.wurst
wurster-headless stdio app.wurst
```

Use `--json` for machine-readable output.

The Parent Wurst runs against its real durable PigFS. A headless Action can write PigFS, close, reopen the same `.wurst` and observe the committed data.

## Child Wursts as subtools

A browserless Parent can use another Wurst directly:

```js
PigLink.define({
  actions: {
    async build(input) {
      await wurst.pigfs.write('/workspace/request.json',
        new TextEncoder().encode(JSON.stringify(input)));

      return wurst.piglet.invoke(
        'pigfs:/workspace/tools/TexturePacker.wurst',
        'textures.pack',
        input
      );
    }
  }
});
```

For Events or repeated calls, use `wurst.piglet.connect()`. Children are read from Parent package/PigFS range sources; no `<wurst-embed>` and no Host-file extraction are required.

## Current parity boundary

Desktop/Web already let human Views and in-runtime machine clients share one Child Wurst session and writable Child PigFS revision. The browserless harness proves Parent PigFS and Child machine-subtool execution, but its generic nested Child path does not yet have the full writable Child PigFS and Parent-service parity of Desktop/Web.

A separate external CLI/MCP process also cannot yet attach to a session already owned by another Desktop/Web Wurster process. That external machine broker is the major remaining two-ends transport gap.

## Security status

The 0.32.4 CLI harness uses a disposable Node worker and restricted JavaScript context. It is useful for developer-controlled Wursts and CI, but it is **not** the final hostile-third-party-code sandbox. A production headless Wurster still needs a real untrusted-code boundary with CPU, memory and capability budgets.

Pigsty may be invoked through PigLink, but its worker engine remains development-only and native Edge/WASIX availability is explicit. Requested unavailable engines fail rather than silently falling back.
