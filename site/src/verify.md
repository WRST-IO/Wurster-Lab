---
layout: layouts/base.njk
title: Verify a Wurst Publisher
summary: Turn a live domain or email proof into an offline-verifiable WRST.IO publisher certificate.
description: Verify a Wurst publisher domain or email with WRST.IO and download a portable .wurstcert.
permalink: /verify/
---

<main class="verify-main">
<section class="hero compact-hero">
  <span class="hero-doodle left">📮</span>
  <span class="hero-doodle right">🔏</span>
  <h1>Prove it once.</h1>
  <h1 class="accent">Verify it offline.</h1>
  <p>Load a signed <strong>.wurstreq</strong> created by MeatGrinder. WRST.IO can verify control of its domain or email claim and return a portable <strong>.wurstcert</strong>. Your publisher private key and Meatphrase never enter this page.</p>
</section>

<section class="verify-shell">
  <div class="verify-file-row">
    <label class="verify-file">
      <span class="verify-file-icon">📨</span>
      <span><strong>Publisher request</strong><small id="requestFileName">Choose a .wurstreq</small></span>
      <input id="requestFile" type="file" accept=".wurstreq,application/json">
    </label>
    <label class="verify-file optional">
      <span class="verify-file-icon">🎖️</span>
      <span><strong>Existing certificate</strong><small id="certificateFileName">Optional, to add another verified claim</small></span>
      <input id="certificateFile" type="file" accept=".wurstcert,application/json">
    </label>
  </div>

  <div id="verifyStatus" class="verify-status">Waiting for a signed publisher request.</div>

  <div id="subjectCard" class="verify-subject hidden">
    <div><span>Publisher key</span><strong id="subjectFingerprint"></strong></div>
    <div><span>Domain claim</span><strong id="subjectDomain">—</strong></div>
    <div><span>Email claim</span><strong id="subjectEmail">—</strong></div>
  </div>

  <div id="claimActions" class="verify-actions hidden">
    <article id="domainCard" class="verify-card hidden">
      <div class="verify-card-head"><span>🌐</span><div><h2>Domain verification</h2><p>WRST.IO checks a short-lived DNS TXT challenge once.</p></div></div>
      <div id="domainReady"><button id="domainBegin" class="btn btn-primary">Create DNS challenge</button></div>
      <div id="domainChallenge" class="hidden">
        <div class="verify-record"><code id="domainRecordName"></code><b>TXT</b><code id="domainRecordValue"></code></div>
        <p class="verify-help">Add the record at your DNS provider, wait until it resolves, then certify it.</p>
        <button id="domainComplete" class="btn btn-primary">I added it · Certify domain</button>
      </div>
    </article>

    <article id="emailCard" class="verify-card hidden">
      <div class="verify-card-head"><span>📮</span><div><h2>Email verification</h2><p>WRST.IO sends a six-digit code from <strong>oink@wrst.io</strong>.</p></div></div>
      <div id="emailReady"><button id="emailBegin" class="btn btn-primary">Send verification code</button></div>
      <div id="emailChallenge" class="hidden">
        <label class="verify-code-label" for="emailCode">Six-digit code</label>
        <input id="emailCode" class="verify-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
        <button id="emailComplete" class="btn btn-primary">Verify email</button>
      </div>
      <p id="emailUnavailable" class="verify-help hidden">Email verification is not enabled on the Authority service yet. Domain verification remains available.</p>
    </article>
  </div>

  <div id="certificateResult" class="verify-result hidden">
    <span class="verify-seal">🐷✓</span>
    <div><strong>Verified by WRST.IO</strong><p id="certificateClaims"></p></div>
    <button id="downloadCertificate" class="btn btn-primary">Download .wurstcert</button>
  </div>
</section>

<p class="viewer-note"><strong>What is being verified?</strong> A publisher label such as “John Doe” is self-declared unless a future verification method explicitly proves it. WRST.IO only marks the exact claims it actually checked, currently domain ownership and, when enabled, email control.</p>
</main>
<script type="module" src="/assets/js/authority-verify.js"></script>
