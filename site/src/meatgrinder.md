---
layout: layouts/base.njk
title: MeatGrinder
description: Turn a browser-ready project into one portable Wurst. The desktop Wurster includes MeatGrinder on its flip side.
permalink: /meatgrinder/
---

<main class="page-main">
  <div class="page-head"><h1>MeatGrinder</h1></div>
  <p class="page-sub">A normal web project goes in. One Wurst comes out. 🐷</p>

  <div class="wide-banner" style="margin-top:28px;">
    <img src="/assets/img/meatgrinder.png" alt="MeatGrinder">
    <div>
      <h2>Zero-config first</h2>
      <p>A folder containing <code>index.html</code> needs no Wurst manifest. Add <code>wurst.json</code> only for Wurst-specific behavior such as WurstFS, window presentation, sealing, capabilities or the Wurst Interface.</p>
    </div>
  </div>

{% terminal "🥩 MeatGrinder CLI" %}
$ meatgrinder build ./my-app
$ meatgrinder inspect ./my-app.wurst
$ meatgrinder publisher create --domain example.com
{% endterminal %}

  <div class="section-title" style="padding-left:0;padding-right:0;text-align:left;">
    <h2>Desktop first</h2>
    <p>The current working MeatGrinder is built into the Wurster desktop launcher. This website ships the documentation and presentation layer; it does not pretend to be an online build service.</p>
  </div>
</main>
