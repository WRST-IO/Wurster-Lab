const { EleventyHtmlBasePlugin } = require("@11ty/eleventy");

module.exports = function (eleventyConfig) {
  // ---- Passthrough assets --------------------------------------------
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ "src/.well-known": ".well-known" });
  eleventyConfig.addPassthroughCopy("src/CNAME");

  // ---- Let Nunjucks run first inside Markdown, so shortcodes work ----
  // This is what makes the reusable components below usable directly
  // inside .md files (frontpage copy, examples, docs), not just .njk.
  eleventyConfig.setLibrary("md", require("./eleventy/markdown.js"));

  eleventyConfig.addWatchTarget("src/assets/css/");

  // ---- Collections ------------------------------------------------------
  function sortDocs(docs) {
    return docs.sort((a, b) => {
      const go = (a.data.groupOrder ?? 0) - (b.data.groupOrder ?? 0);
      if (go !== 0) return go;
      return (a.data.order ?? 0) - (b.data.order ?? 0);
    });
  }

  eleventyConfig.addCollection("docs", (api) =>
    sortDocs(api.getFilteredByTag("doc"))
  );

  eleventyConfig.addCollection("docGroups", (api) => {
    const docs = sortDocs(api.getFilteredByTag("doc"));
    const groups = [];
    for (const doc of docs) {
      let group = groups.find((g) => g.title === doc.data.group);
      if (!group) {
        group = { title: doc.data.group, order: doc.data.groupOrder, items: [] };
        groups.push(group);
      }
      group.items.push(doc);
    }
    groups.sort((a, b) => a.order - b.order);
    return groups;
  });

  eleventyConfig.addCollection("examples", (api) =>
    api.getFilteredByTag("example").sort(
      (a, b) => (a.data.order ?? 0) - (b.data.order ?? 0)
    )
  );

  // ---- Shortcodes: reusable frontpage/markdown building blocks -------
  require("./eleventy/shortcodes.js")(eleventyConfig);

  // ---- Filters ---------------------------------------------------------
  eleventyConfig.addFilter("findBySlug", (arr, slug) =>
    (arr || []).find((d) => d.data.slug === slug || d.fileSlug === slug)
  );

  eleventyConfig.addPlugin(EleventyHtmlBasePlugin);
  eleventyConfig.addGlobalData("year", () => new Date().getFullYear());

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    templateFormats: ["md", "njk", "html"],
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
};
