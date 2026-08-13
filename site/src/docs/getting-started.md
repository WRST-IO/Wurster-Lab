---
title: Getting Started
group: Getting Started
groupOrder: 1
order: 2
---
# Getting Started

Native Wurst files may use either `.wurst` or `.wrst`. The two extensions are format-identical and equally valid; `.wurst` is simply the friendlier default in examples.

Wurster is one desktop application with two sides. The front opens `.wurst`, `.wrst` and Undercover Wurst PNGs. Flip the launcher and the back becomes **MeatGrinder**, which turns browser-ready folders or ZIPs into Wursts.

The CLI remains available for automation and build systems.

## Build your first Wurst

Start with a folder like this:

```text
hello-pig/
├── index.html
├── app.js
└── style.css
```

No `wurst.json` is required.

Open MeatGrinder, drop the `hello-pig` folder into the project field and press **Start MeatGrinder**. The default output is named after the input folder:

```text
hello-pig.wurst
```

Open that file with Wurster.

The same zero-configuration build works from the CLI:

```bash
meatgrinder build ./hello-pig
```

## When to add wurst.json

Add a manifest only when you want to override defaults.

```json
{
  "id": "com.example.hello-pig",
  "name": "Hello Pig",
  "version": "1.0.0",
  "entry": "index.html",
  "window": {
    "width": 640,
    "height": 420,
    "transparent": true,
    "frame": false
  }
}
```

That is a special order at the butcher counter. Ordinary Wursts do not need one.

## Undercover Wurst

Drop a PNG or JPEG into MeatGrinder's optional image slot before grinding. JPEG carriers are converted to PNG locally. The result is a valid PNG containing the complete Wurst in private `wuSt` chunks.

Normal image viewer: picture.

Wurster: suspicious sniffing, followed by application.
