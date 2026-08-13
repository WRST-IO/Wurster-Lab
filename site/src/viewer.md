---
layout: layouts/base.njk
title: Wurst Viewer
description: Open a .wurst or .wrst directly in your browser with Wurster Web. No desktop runtime required.
permalink: /viewer/
---

<main class="viewer-main">
  <div class="page-head"><h1>Wurst Viewer</h1></div>
  <p class="page-sub">Drop in a Wurst. Wurster Web opens it locally in your browser. Public, partial or fully WurstKey-sealed.</p>

  <section class="viewer-shell">
    <div class="viewer-dropzone" id="viewerDropzone" tabindex="0" role="button" aria-label="Choose a Wurst file">
      <img src="/assets/img/wurst-file.png" alt="" class="viewer-wurst-icon">
      <div>
        <h2>Drop a <code>.wurst</code> / <code>.wrst</code> here</h2>
        <p>or choose one from your device. The file stays in this browser session unless the Wurst itself uses declared network access.</p>
      </div>
      <button class="btn btn-primary" id="viewerChoose" type="button">Choose Wurst</button>
      <input id="viewerFile" type="file" accept=".wurst,.wrst,application/octet-stream" hidden>
    </div>

    <div class="viewer-info" id="viewerInfo" hidden>
      <div><span class="viewer-label">Wurst</span><strong id="viewerName">—</strong></div>
      <div><span class="viewer-label">Protection</span><strong id="viewerProtection">—</strong></div>
      <div><span class="viewer-label">Publisher identity</span><strong id="viewerIdentity">—</strong></div>
      <button class="btn btn-secondary" id="viewerClose" type="button">Close Wurst</button>
    </div>

    <div class="viewer-stage-wrap" id="viewerStageWrap" hidden>
      <wurst-embed id="viewerStage" title="Wurster online viewer"></wurst-embed>
    </div>

    <p class="viewer-status" id="viewerStatus">No Wurst on the grill yet.</p>
  </section>

  <section class="viewer-note">
    <strong>Encrypted Wurst?</strong>
    A fully sealed Wurst asks for its WurstKey in Wurster-owned UI before any application HTML runs. A partial Wurst can show its public shell first and request the key only when protected content is needed.
  </section>
</main>
<script type="module" src="/assets/js/wurst-viewer.js"></script>
