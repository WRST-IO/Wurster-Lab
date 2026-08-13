---
layout: layouts/base.njk
title: Examples
description: A handful of real .wurst files, built to show off what a single portable app file can do.
permalink: /examples/
eleventyExcludeFromCollections: true
---

<main class="page-main">
  <div class="page-head-icon">
    <img src="/assets/img/wurst-file.png" alt="">
    <h1>Test Wurste</h1>
  </div>
  <p class="page-sub">A handful of real .wurst files, built to show off what a single portable app file can do.</p>

  <div class="example-grid">
    {%- for ex in collections.examples -%}
    <div class="example-card">
      <a class="example-card-link" href="{{ ex.url }}" aria-label="{{ ex.data.title }}"></a>
      <div class="example-thumb">
        {%- if ex.data.thumbnail -%}
        <img class="real-thumb" src="{{ ex.data.thumbnail }}" alt="">
        {%- else -%}
        <span class="placeholder-label">app thumbnail</span>
        {%- endif %}
        <span class="tag">{{ ex.data.tag }}</span>
      </div>
      <div class="example-body">
        <div class="name">{{ ex.data.title }}</div>
        <p>{{ ex.data.summary }}</p>
      </div>
    </div>
    {%- endfor %}
  </div>

  {% ctaBanner "pig.png", "Got a Wurst worth showing off?", "This gallery grows with every release. Grind something fun with MeatGrinder and send it our way — we'll slice it up and give it a spot on this page.", "Read the docs", "/docs/" %}
</main>
