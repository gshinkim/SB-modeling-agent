/* node --test web/js/md.test.mjs
   The renderer's input is whatever a language model emitted, which may be quoting
   a file, a tool result or a web page. Most of this file is therefore about what
   must NOT survive rendering. */
import assert from 'node:assert/strict';
import { renderMarkdown, sanitizeSvg } from './md.mjs';

const has = (src, frag, why) => assert.ok(renderMarkdown(src).includes(frag),
  why + '\n  wanted: ' + frag + '\n  got:    ' + renderMarkdown(src));
const lacks = (src, frag, why) => assert.ok(!renderMarkdown(src).includes(frag),
  why + '\n  banned: ' + frag + '\n  got:    ' + renderMarkdown(src));

/* --------------------------------- formatting --------------------------------- */
has('# Heading', '<h1>Heading</h1>', 'atx heading');
has('###### six', '<h6>six</h6>', 'deepest heading');
has('**bold**', '<strong>bold</strong>', 'bold');
has('*ital*', '<em>ital</em>', 'italic');
has('==hi==', '<mark>hi</mark>', 'highlight');
has('~~gone~~', '<del>gone</del>', 'strikethrough');
has('`x=1`', '<code>x=1</code>', 'inline code');
has('```py\nprint(1)\n```', '<pre><code class="lang-py">print(1)</code></pre>', 'fenced block');
has('- a\n- b', '<li>a</li>', 'unordered list');
has('1. a\n2. b', '<ol>', 'ordered list');
has('> quoted', '<blockquote>', 'blockquote');
has('---', '<hr>', 'rule');
has('| a | b |\n| - | - |\n| 1 | 2 |', '<th>a</th>', 'table header');
has('| a | b |\n| - | - |\n| 1 | 2 |', '<td>1</td>', 'table body');
has('[ok](https://x.com)', 'href="https://x.com"', 'http link');
has('plain words', '<p>plain words</p>', 'paragraph');
// a fence must not be read as markdown
lacks('```\n**not bold**\n```', '<strong>', 'markdown inside a fence stays literal');
console.log('formatting ok');

/* ----------------------------------- XSS ----------------------------------- */
lacks('<script>alert(1)</script>', '<script', 'script tag in the body');
has('<script>alert(1)</script>', '&lt;script', 'script tag is shown as text');

lacks('<svg onload="alert(1)"></svg>', 'onload', 'svg event handler');
lacks('<svg onload=alert(1)></svg>', 'alert', 'unquoted event handler');
lacks('<svg ONLOAD="alert(1)"></svg>', 'ONLOAD', 'uppercased event handler');
lacks('<svg><script>alert(1)</script></svg>', 'alert', 'script nested inside svg');
lacks('<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>',
      'onerror', 'html smuggled through foreignObject');
lacks('<svg><foreignObject><b>hi</b></foreignObject></svg>', 'foreignObject', 'foreignObject dropped');
lacks('<svg><use href="http://evil/x#a"/></svg>', '<use', 'use element is not allowlisted');
lacks('<svg><image href="javascript:alert(1)"/></svg>', '<image', 'image element is not allowlisted');
lacks('<svg><animate onbegin="alert(1)"/></svg>', 'onbegin', 'animation handler');
lacks('<svg><style>*{x:y}</style></svg>', '<style', 'style element');

lacks('[click](javascript:alert(1))', 'javascript:', 'javascript: link scheme');
has('[click](javascript:alert(1))', 'click', 'link text survives a rejected href');
lacks('[click](data:text/html;base64,PHN2Zz4=)', 'href="data:', 'data: link scheme');
lacks('[click](vbscript:msgbox)', 'href="vbscript', 'vbscript: link scheme');
has('[m](mailto:a@b.c)', 'href="mailto:a@b.c"', 'mailto is allowed');

lacks('<img src=x onerror=alert(1)>', '<img', 'raw img tag');
lacks('<iframe src="http://evil"></iframe>', '<iframe', 'raw iframe');
// div IS allowlisted now, so it renders - but never with its handler
lacks('<div onclick="alert(1)">hi</div>', 'onclick', 'handler stripped from an allowed tag');
has('<div onclick="alert(1)">hi</div>', '<div>hi</div>', 'the allowed tag itself survives');
lacks('<b onmouseover="x()">hi</b>', 'onmouseover', 'handler stripped from an inline tag');
lacks('<table><tr><td onclick="x()">1</td></tr></table>', 'onclick', 'handler inside a block');
lacks('<p style="color:red">s</p>', 'style', 'style attribute is not allowlisted');
lacks('<svg fill="url(http://evil/x)"></svg>', 'evil', 'external url() reference');
console.log('xss ok');

/* ------------------- html the model wrote instead of markdown ------------------- */
has('<b>bold</b>', '<b>bold</b>', 'inline bold html renders');
has('<i>it</i> and <em>em</em>', '<em>em</em>', 'inline emphasis renders');
has('line<br>break', '<br>', 'a void tag renders');
has('<h2>Head</h2>', '<h2>Head</h2>', 'a heading block renders');
has('<ul><li>one</li></ul>', '<li>one</li>', 'a list block renders');
has('<table><tr><th>a</th></tr><tr><td>1</td></tr></table>', '<th>a</th>', 'a table block renders');
has('<a href="https://x.com">go</a>', 'href="https://x.com"', 'a safe href survives');
has('mixed <b>html</b> and **markdown**', '<strong>markdown</strong>', 'markdown still works alongside');
has('mixed <b>html</b> and **markdown**', '<b>html</b>', '...and so does the html');
// two block elements on one line must not end up nested inside a paragraph
lacks('<h2>A</h2><p>B</p>', '<p><h2>', 'blocks are not wrapped in a paragraph');
console.log('html passthrough ok');

/* --------------------------- svg that should survive --------------------------- */
{
  const good = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#f00"/>' +
               '<text x="1" y="9" font-size="3">S1</text></svg>';
  const out = renderMarkdown(good);
  assert.ok(out.includes('<svg'), 'a clean diagram renders');
  assert.ok(out.includes('viewBox="0 0 10 10"'), 'camelCase attribute kept its spelling');
  assert.ok(out.includes('<circle'), 'shapes kept');
  assert.ok(out.includes('r="4"'), 'geometry kept');
  assert.ok(out.includes('S1'), 'label text kept');
}
// a gradient reference inside the same document is legitimate — kept, but
// namespaced along with every other id (see 'svg id namespacing' below)
assert.ok(sanitizeSvg('<svg><rect fill="url(#g)"/></svg>').includes('url(#md-g)'),
  'internal url(#id) reference kept');
console.log('svg passthrough ok');

/* ------------------------------ malformed input ------------------------------ */
for (const junk of ['<svg', '<svg><circle', '</svg>', '<<>>', '<svg><g><g></svg>',
                    '```unclosed', '| a |\n| - |', '***', '<', '&', null, undefined, '']) {
  assert.doesNotThrow(() => renderMarkdown(junk), 'must not throw on: ' + junk);
}
// an unclosed allowlisted tag must still be balanced on the way out
{
  const out = sanitizeSvg('<svg><g><circle r="1"/>');
  assert.equal((out.match(/<g>/g) ?? []).length, (out.match(/<\/g>/g) ?? []).length,
    'unclosed tags are balanced');
}
// a sentinel typed by the model must not be able to reach held content
lacks('\uE000 0 \uE000 ping', 'ping</pre>', 'a typed sentinel cannot forge a placeholder');
console.log('malformed input ok');

/* --------------------------- svg id namespacing --------------------------- */
/* Agent-authored SVG shares the page's DOM. An unprefixed id could collide with
   the app's own dialog ids ($('#sp'), $('#fp')) and silently break them. */
assert.equal(sanitizeSvg('<svg><g id="sp"/></svg>'), '<svg><g id="md-sp"/></svg>',
  'an svg id is namespaced');
assert.ok(sanitizeSvg('<svg><path marker-end="url(#a)"/></svg>').includes('url(#md-a)'),
  'a marker-end url(#x) reference is renamed to match');
assert.ok(!sanitizeSvg('<svg><g id="sp"/></svg>').includes('id="sp"'),
  'the bare unnamespaced id never survives');
console.log('svg id namespacing ok');

/* ------------------------------------ tex ------------------------------------ */
/* No KaTeX under node: maths must come back as its own source, untouched by
   markdown. Then with a stub KaTeX, each delimiter must reach it intact. */
has('$a_1 * b_2 * c$', '$a_1 * b_2 * c$', 'inline maths is not read as emphasis');
lacks('$a_1 * b_2 * c$', '<em>', 'no emphasis inside maths');
has('$$ x_1 \\cdot y_1 $$', '<span class="math-src" data-tex="x_1 \\cdot y_1" data-display>$$ x_1 \\cdot y_1 $$</span>', 'display source kept');
has('\\( C^J_{1} \\) and \\[ J \\]', '\\( C^J_{1} \\)', 'paren delimiters kept');
has('`$x$` here', '<code>$x$</code>', 'a code span is not maths');
has('```\n$$ keep $$\n```', '$$ keep $$</code>', 'a fence is not maths');
lacks('```\n$$ keep $$\n```', 'math-src', 'no maths inside a fence');
// `$X0` is Antimony's boundary-species marker, not maths
lacks('$X0 -> S1; $X1 fixed', 'math-src', 'Antimony $ is left alone');
lacks('from $5 to $10', 'math-src', 'prices are left alone');
has('> $a_b$', '<blockquote><p><span class="math-src" data-tex="a_b">$a_b$</span>', 'maths in a blockquote');
has('$$x$$', 'data-tex="x" data-display>', 'display source keeps its mode for the late upgrade');
has('\\begin{align} a &= b \\end{align}', 'data-tex="\\begin{align} a &amp;= b \\end{align}" data-display', 'bare align is display maths');
// text-mode LaTeX is a <latex-doc>, escaped, and never read as markdown or maths
has('```latex\n\\section{A_b} $x$\n```', '<latex-doc>\\section{A_b} $x$\n</latex-doc>', 'latex fence is a document');
has('\\begin{tabular}{cc} a & *b* \\end{tabular}', '<latex-doc>\\begin{tabular}{cc} a &amp; *b* \\end{tabular}</latex-doc>', 'bare tabular is a document');
lacks('`\\begin{itemize}\\end{itemize}`', 'latex-doc', 'code span is not a document');
lacks('```text\n\\begin{itemize}\\end{itemize}\n```', 'latex-doc', 'text fence shows source');
lacks('```latex\n\\section{A} still streaming', 'latex-doc', 'an open latex fence is not compiled yet');
lacks('<b>x</b> <latex-doc>', '<latex-doc>', 'a typed latex-doc tag is not trusted');

globalThis.MathJax = { tex2svg: (t, o) => ({ outerHTML: '<K' + (o.display ? 'D' : '') + '>' + t + '</K>' }) };
has('so $a_1*b$ is', '<K>a_1*b</K>', 'inline $ reaches mathjax');
has('$$\n\\frac{a}{b}\n$$', '<KD>\\frac{a}{b}</K>', 'multiline $$ is display');
has('\\[ J \\]', '<KD>J</K>', '\\[ is display');
has('\\( J_1 \\)', '<K>J_1</K>', '\\( is inline');
has('\\begin{pmatrix} a \\end{pmatrix} vs \\begin{gather*} x \\end{gather*}', '<KD>\\begin{gather*} x \\end{gather*}</K>', 'starred env is display');
has('<table><tr><td>$x_1$</td></tr></table>', '<td><K>x_1</K></td>', 'maths inside held html');
lacks('`$x$`', '<K>', 'code span never reaches mathjax');
delete globalThis.MathJax;
console.log('tex ok');

console.log('md.test.mjs ok');


// a ```html fence runs live, sandboxed: scripts allowed, same origin and the network not
{
  const out = renderMarkdown('```html\n<button onclick="x()">k1</button><script>x=()=>1</script>\n```');
  assert.ok(out.includes('<iframe sandbox="allow-scripts"'), 'sandboxed frame');
  assert.ok(!/allow-same-origin/.test(out), 'never same-origin');
  assert.ok(out.includes('onclick=&quot;x()&quot;'), 'the handler reaches the frame, escaped into srcdoc');
  assert.ok(!out.includes('<script>x='), 'no live script in the page itself');
  assert.ok(/connect-src &#39;none&#39;/.test(out) && /form-action &#39;none&#39;/.test(out), 'no way out of the frame');
  assert.ok(!renderMarkdown('```html\n<b>still streaming').includes('<iframe'), 'an open fence is not run yet');
  assert.ok(!renderMarkdown('<svg><script>x()</script></svg>').includes('x()'), 'inline svg stays sanitized');
  console.log('live html fences ok');
}
