---
layout: layouts/base.njk
title: One File. One Runtime Contract. One Wurst.
description: Wurst is a portable mini-app format with WurstFS, signatures, slicing and a conforming runtime contract.
permalink: /
---

<main>

<section class="hero">
  <span class="hero-doodle left">🥓</span>
  <span class="hero-doodle right">🌭</span>
  <h1>One File. One Runtime Contract.</h1>
  <h1 class="accent">One Wurst.</h1>
  <p>
    Package a normal HTML/CSS/JavaScript mini-app as one portable <strong>.wurst</strong> or <strong>.wrst</strong> file.
    Keep application data inside WurstFS, stream large content in slices, and let each conforming Wurster runtime handle its own platform details.
  </p>
  <div class="hero-actions">
    <a class="btn btn-primary btn-lg" href="/docs/getting-started/">🚀 Get Started</a>
    <a class="btn btn-secondary btn-lg" href="/docs/">📖 View Docs</a>
  </div>
</section>

<section class="project-status"><strong>Pre-1.0 development project.</strong> Wurster is under active development and is not currently published under an open-source license. The 1.0 release is intended to move to a permissive open-source license; MIT is the current candidate. Until a LICENSE file says otherwise, the source remains all rights reserved.</section>

{% processDiagram %}

<section id="features" class="card-grid">

{% featureCard "format", "The .wurst Format", "A tiny random-access binary container for an app, immutable resources and optional mutable WurstFS data." %}

{% featureCard "runtime", "Conforming Wurster Runtimes", "The runtime implementation may differ per platform; the Wurst format and portable behavior stay the same." %}

{% featureCard "img:meatgrinder.png", "MeatGrinder", "Drop in a browser-ready folder or ZIP. Special Wurst behavior is optional rather than a new programming model." %}

</section>

<div class="section-title">
  <h2>Why a Wurst?</h2>
  <p>Because applications and their data deserve a portable existence outside one browser profile, marketplace or mandatory cloud.</p>
</div>

<section style="max-width: 1080px; margin: 0 auto; padding: 0 clamp(16px,5vw,24px);">
<div class="capability-grid">

{% capabilityCard "🔏", "Federated signatures", "Sign locally with Ed25519. Add optional domain, local-trust or Authority identity without making any central service mandatory." %}

{% capabilityCard "📁", "WurstFS", "Create, read, update, delete, stream and compact app-owned files inside the Wurst itself — plain or Meatphrase-sealed." %}

{% capabilityCard "🔪", "Sliceable & streamable", "Large Wursts can be inspected and read by byte range instead of downloading or loading the whole binary first." %}

{% capabilityCard "🥷", "Undercover Wurst", "Carry the same WRST payload inside a valid PNG using private wuSt chunks." %}

</div>
</section>

<div class="terminal-wrap">
{% terminal "🌭 Wurster Lab 0.16" %}
$ meatgrinder build app/ dist/my-app.wurst
$ meatgrinder publisher create --domain example.com
$ meatgrinder build app/ dist/my-app.wurst --sign example.com.wurstkey
{% endterminal %}
</div>

</main>
