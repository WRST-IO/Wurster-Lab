---
layout: layouts/base.njk
title: Wurster Runtime
description: A Wurst is platform-independent; each conforming Wurster runtime implements the same portable contract with platform-specific technology.
permalink: /runtime/
stylesheets:
  - /assets/css/runtime.css
---

<main class="page-main runtime-page">
  <div class="page-head"><h1>Wurster Runtime</h1></div>
  <p class="page-sub">Same Wurst semantics, not the same runtime implementation.</p>

  <div class="platform-lede">
    <img src="/assets/img/wurst-file.png" alt="">
    <span>one portable Wurst, multiple conforming runtimes ↓</span>
  </div>

  <div class="platform-grid">
    <div class="platform-card">
      <div class="platform-card-body">
        <span class="platform-badge">Current alpha</span>
        <div class="platform-icon">{% platformIcon "windows" %}</div>
        <h3>Windows</h3>
        <p>Desktop Wurster uses Electron for controlled Chromium sessions, WurstFS and native runtime bridges.</p>
        {% if releases.available %}<a class="runtime-download" href="{{ releases.windowsX64 }}">↓ Download Setup.exe <small>x64</small></a>{% else %}<span class="runtime-download disabled">↓ Download Setup.exe <small>after GitHub deploy</small></span>{% endif %}
      </div>
    </div>
    <div class="platform-card">
      <div class="platform-card-body">
        <span class="platform-badge">Current alpha</span>
        <div class="platform-icon">{% platformIcon "macos" %}</div>
        <h3>macOS</h3>
        <p>Choose the native DMG for Apple Silicon or Intel. Both run the same portable Wurst contract.</p>
        {% if releases.available %}<details class="runtime-download-menu"><summary class="runtime-download">↓ Download .dmg <span>⌄</span></summary><div class="runtime-download-popover"><a href="{{ releases.macArm64 }}"><strong>Apple Silicon</strong><small>arm64 · M1 and newer</small></a><a href="{{ releases.macX64 }}"><strong>Intel Mac</strong><small>x64</small></a></div></details>{% else %}<span class="runtime-download disabled">↓ Download .dmg <small>after GitHub deploy</small></span>{% endif %}
      </div>
    </div>
    <div class="platform-card">
      <div class="platform-card-body">
        <span class="platform-badge">Planned for 1.0 family</span>
        <div class="platform-icon">{% platformIcon "linux" %}</div>
        <h3>Linux</h3>
        <p>A conforming runtime target. The Wurst file itself requires no Linux-specific build.</p>
        <span class="runtime-download disabled">Coming soon</span>
      </div>
    </div>
    <div class="platform-card">
      <div class="platform-card-body">
        <span class="platform-badge">Current alpha</span>
        <div class="platform-icon">{% platformIcon "web" %}</div>
        <h3>Wurster Web</h3>
        <p>Browser Wurster powers <code>&lt;wurst-embed&gt;</code> and the online Viewer. The exact release runtime is published beside the native runtimes.</p>
        {% if releases.available %}<details class="runtime-download-menu"><summary class="runtime-download">↓ Download Web runtime <span>⌄</span></summary><div class="runtime-download-popover"><a href="{{ releases.webMin }}"><strong>Minified ESM</strong><small>wurster.min.js</small></a><a href="{{ releases.webJs }}"><strong>Readable ESM</strong><small>wurster.js</small></a><a href="{{ releases.webZip }}"><strong>Complete distribution</strong><small>runtime + worker + embed host</small></a></div></details>{% else %}<span class="runtime-download disabled">↓ Download Web runtime <small>after GitHub deploy</small></span>{% endif %}
        <div class="runtime-coming-soon"><a href="/viewer/">Open Wurst Viewer ↗</a></div>
      </div>
    </div>
  </div>

  {% if releases.available %}
  <div class="runtime-release-strip">
    <div><strong>Wurster {{ releases.version }}</strong><span>GitHub Release · native installers + Web Runtime + SHA-256 checksums</span></div>
    <a class="btn btn-ghost" href="{{ releases.releaseUrl }}">All release assets ↗</a>
  </div>
  {% endif %}

{% wideBanner "wurst-badge.png", "A missing capability is not a broken Wurst", "A runtime may report an optional capability as unsupported. The Wurst still opens and can handle that state itself. Platform mechanisms belong to Wurster, never to the file format." %}

</main>
