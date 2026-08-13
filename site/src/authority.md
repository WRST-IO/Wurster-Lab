---
layout: layouts/base.njk
title: WRST.IO Authority
description: Offline-first publisher identity for Wurst, with a pinned root and stateless DNS issuance.
permalink: /authority/
---

<main>
<section class="hero compact-hero">
  <span class="hero-doodle left">🔏</span>
  <span class="hero-doodle right">🐷</span>
  <h1>Trust the Wurst.</h1>
  <h1 class="accent">Offline.</h1>
  <p><strong>WRST.IO</strong> is the official Wurster project site and default publisher Authority. It certifies exact publisher claims once; Wurster verifies the resulting chain locally without phoning home whenever you open a Wurst. WRST.IO is a project, not a company or incorporated identity provider.</p>
  <div class="hero-actions">
    <a class="btn btn-primary btn-lg" href="/docs/authority/">Read the trust model</a>
    <a class="btn btn-secondary btn-lg" href="/verify/">Verify a publisher</a>
  </div>
</section>

<div class="section-title">
  <h2>Root offline. Issuer online. Wurst portable.</h2>
  <p>The Root private key is recovered only from an offline Root Meatphrase. A separate rotatable issuer signs publisher certificates after domain or email proof.</p>
</div>

<section style="max-width:1080px;margin:0 auto;padding:0 clamp(16px,5vw,24px);">
<div class="capability-grid">
{% capabilityCard "🧾", "Offline certificates", "The issuer certificate and publisher certificate travel with the signed Wurst. Normal verification needs no Authority request." %}
{% capabilityCard "🌐", "Domain proof", "WRST.IO proves control of a publisher domain through a short-lived DNS TXT challenge." %}
{% capabilityCard "📮", "Email proof", "When outbound mail is enabled, WRST.IO sends a six-digit code from oink@wrst.io and certifies only the email address that successfully returns it." %}
{% capabilityCard "🔄", "Root-signed trust data", "Issuer rotation and revocation are distributed as a signed trust bundle while package verification remains offline-first." %}
{% capabilityCard "🧱", "No central requirement", "Unsigned Wursts, direct DNS identity and locally trusted publisher keys continue to work without wrst.io." %}
</div>
</section>
</main>
