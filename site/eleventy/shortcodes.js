/**
 * Reusable content blocks — registered as Eleventy shortcodes so they can be
 * dropped straight into any Markdown file (frontpage copy, examples, docs),
 * not just .njk templates. See README.md "Content components" for the list.
 */

const SVG_ICONS = {
  format: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#E15A73" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>',
  runtime: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#E15A73" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>',
  windows: '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#E15A73" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>',
  macos: '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#E15A73" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9"></path><path d="M2.5 16h19l-1.8 3.2a2 2 0 0 1-1.74 1H6.04a2 2 0 0 1-1.74-1z"></path></svg>',
  linux: '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#E15A73" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><polyline points="7 9 11 12 7 15"></polyline><line x1="12" y1="15" x2="16" y2="15"></line></svg>',
  web: '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#E15A73" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="3" y1="12" x2="21" y2="12"></line><path d="M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"></path></svg>',
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderIcon(icon) {
  if (!icon) return "";
  if (SVG_ICONS[icon]) return SVG_ICONS[icon];
  if (icon.startsWith("img:")) return `<img src="/assets/img/${esc(icon.slice(4))}" alt="">`;
  return `<span style="font-size:26px;line-height:1;">${esc(icon)}</span>`;
}

module.exports = function (eleventyConfig) {
  eleventyConfig.addShortcode("platformIcon", function (icon) { return renderIcon(icon); });

  // {% featureCard "format", "The .wurst Format", "Bundle a complete web app ... into a single portable binary file." %}
  eleventyConfig.addShortcode("featureCard", function (icon, title, desc) {
    return `<div class="feature-card">
      <div class="feature-card-icon">${renderIcon(icon)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
    </div>`;
  });

  // {% capabilityCard "🔏", "Signed by identity", "Sign a Wurst against a verified email or domain..." %}
  eleventyConfig.addShortcode("capabilityCard", function (emoji, title, desc) {
    return `<div class="capability-card">
      <span class="emoji">${esc(emoji)}</span>
      <div>
        <div class="title">${esc(title)}</div>
        <div class="desc">${esc(desc)}</div>
      </div>
    </div>`;
  });

  // {% processDiagram %} — the pig -> MeatGrinder -> .wurst diagram, fixed content
  eleventyConfig.addShortcode("processDiagram", function () {
    return `<div class="process">
      <div class="process-card">
        <div class="process-step">
          <img class="pig" src="/assets/img/pig.png" alt="Source pig — your HTML/JS/CSS app">
          <span>your web app</span>
        </div>
        <span class="process-arrow">&rarr;</span>
        <div class="process-step">
          <img class="grinder" src="/assets/img/meatgrinder.png" alt="MeatGrinder">
          <span>MeatGrinder</span>
        </div>
        <span class="process-arrow">&rarr;</span>
        <div class="process-step">
          <img class="wurst-file" src="/assets/img/wurst-file.png" alt=".wurst file">
          <span>my-app.wurst</span>
        </div>
      </div>
      <p class="process-tagline">&#10022; Made of 100% Pork Meat &mdash; No animals were harmed &#10022;</p>
    </div>`;
  });

  // {% callout "🐷 A Wurst can hold user data too ..." %}
  eleventyConfig.addShortcode("callout", function (text) {
    return `<div class="callout">${esc(text)}</div>`;
  });

  // {% ctaBanner "pig.png", "Got a Wurst worth showing off?", "This gallery grows with every release...", "Read the docs", "/docs/" %}
  eleventyConfig.addShortcode("ctaBanner", function (image, title, desc, buttonLabel, buttonHref) {
    return `<div class="cta-banner">
      <img src="/assets/img/${esc(image)}" alt="">
      <h2>${esc(title)}</h2>
      <p>${esc(desc)}</p>
      ${buttonLabel ? `<a class="btn btn-primary" href="${esc(buttonHref || "#")}">${esc(buttonLabel)}</a>` : ""}
    </div>`;
  });

  // {% wideBanner "wurst-badge.png", "Run everywhere, run the same", "The .wurst format is built to be universal: ..." %}
  eleventyConfig.addShortcode("wideBanner", function (image, title, desc) {
    return `<div class="wide-banner">
      <img src="/assets/img/${esc(image)}" alt="">
      <div>
        <h2>${esc(title)}</h2>
        <p>${esc(desc)}</p>
      </div>
    </div>`;
  });

  // {% platformCard "windows", "Native", "Windows", "Native .exe runtime — double-click a .wurst, it just runs.", "winget install wurster" %}
  eleventyConfig.addShortcode("platformCard", function (icon, badge, title, desc, command) {
    return `<div class="platform-card">
      <div class="platform-card-stripe"></div>
      <div class="platform-card-body">
        ${badge ? `<span class="platform-badge">${esc(badge)}</span>` : ""}
        <div class="platform-icon">${renderIcon(icon)}</div>
        <h3>${esc(title)}</h3>
        <p>${esc(desc)}</p>
        <div class="platform-command">${esc(command)}</div>
      </div>
    </div>`;
  });

  // {% terminal "wurster — terminal" %}
  // $ meatgrinder build app/ dist/my-app.wurst
  // $ meatgrinder sign dist/my-app.wurst --domain wrst.io
  // $ wurster run dist/my-app.wurst
  // {% endterminal %}
  eleventyConfig.addPairedShortcode("terminal", function (content, label) {
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^\$\s*(\S+)\s*(.*)$/);
        if (!m) return `<div>${esc(line)}</div>`;
        return `<div><span class="prompt">$</span> <span class="cmd">${esc(m[1])}</span> <span class="arg">${esc(m[2])}</span></div>`;
      })
      .join("\n");
    return `<div class="terminal">
      <div class="terminal-stripe"></div>
      <div class="terminal-titlebar">
        <span class="terminal-dot red"></span>
        <span class="terminal-dot yellow"></span>
        <span class="terminal-dot green"></span>
        <span class="label">${esc(label || "wurster — terminal")}</span>
      </div>
      <div class="terminal-body">${lines}</div>
    </div>`;
  });
};
