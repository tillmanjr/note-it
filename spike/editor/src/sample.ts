// Sample note exercising the formatting the spike needs to prove out.
export const SAMPLE_NOTE = `
<h1>Editor spike — sample note</h1>
<p>This paragraph is not indented. <strong>Bold</strong>, <em>italic</em>, <u>underline</u>, <s>strike</s>,
<mark data-color="#fff3a3" style="background-color:#fff3a3">highlight</mark>,
<span style="color:#c0392b">red text</span>, <span style="font-family:Georgia">Georgia</span>,
<span style="font-size:20px">20px text</span>, and a <a href="https://example.com">link</a>.</p>
<p data-indent="1">Indented one level — a real indent, not a quote. Tab / Shift-Tab change it.</p>
<p data-indent="2">Indented two levels. Backspace at the start of this line outdents it.</p>
<p data-indent="1">Back to one level.</p>
<h2>Checklist</h2>
<ul data-type="taskList">
  <li data-type="taskItem" data-checked="true"><p>Done item</p></li>
  <li data-type="taskItem" data-checked="false"><p>Open item</p>
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="false"><p>Nested sub-task (Tab on an item nests it)</p></li>
    </ul>
  </li>
</ul>
<h2>Lists</h2>
<ul>
  <li><p>Bullet</p>
    <ul><li><p>Nested bullet</p>
      <ol><li><p>Nested numbered</p></li><li><p>Second</p></li></ol>
    </li></ul>
  </li>
  <li><p>Another bullet</p></li>
</ul>
<h2>Table</h2>
<table>
  <tr><th><p>Item</p></th><th><p>Qty</p></th><th><p>Notes</p></th></tr>
  <tr><td><p>Widgets</p></td><td><p>3</p></td><td><p><em>Tab moves between cells</em></p></td></tr>
  <tr><td><p>Gadgets</p></td><td><p>12</p></td><td><p></p></td></tr>
</table>
<p style="text-align:center">Centered paragraph.</p>
<pre><code>code block
  keeps   whitespace</code></pre>
<hr>
<p>Try pasting content from a web page, Google Docs or Word below this line, then open the debug pane.</p>
<p></p>
`
