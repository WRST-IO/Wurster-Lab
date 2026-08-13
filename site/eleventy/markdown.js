const markdownIt = require("markdown-it");
const markdownItAnchor = require("markdown-it-anchor");

const md = markdownIt({
  html: true,
  breaks: false,
  linkify: true,
}).use(markdownItAnchor, {
  level: [2, 3],
  permalink: markdownItAnchor.permalink.headerLink(),
});

module.exports = md;
