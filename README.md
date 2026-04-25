# LaTeX Documentation Hover

Adds hover documentation for custom LaTeX macros using a simple JSON file.

Hover over a macro like:

\PlacePointerArrow

and see:
- full signature
- description
- parameter table with defaults

![alt text](<images/example hover.gif>)

---

## How it works

The extension looks for a file in your workspace root:

macro-docs.json

It matches LaTeX commands, such as \PlacePointerArrow, to entries in that file and displays them on hover.

---

## Example macro-docs.json
```json
{
  "\\PlacePointerArrow": {
    "signature": "\\PlacePointerArrow{from=...,to=...,color=...,track=...,style=...,note=...,notepos=...}",
    "description": "Draws a routed pointer arrow between memory cells.",
    "params": {
      "from": { "default": "0", "desc": "Source cell index." },
      "to": { "default": "1", "desc": "Target cell index." },
      "color": { "default": "ptrAarrow", "desc": "TikZ colour used for the arrow." },
      "track": { "default": "0", "desc": "Routing lane number." },
      "style": { "default": "flatarc", "desc": "Arrow route style." },
      "note": { "default": "", "desc": "Optional label shown on the arrow." },
      "notepos": { "default": "0.5", "desc": "Position of the note along the arrow from 0 to 1." }
    }
  }
}
```

---

## Usage

1. Install the extension
2. Add macro-docs.json to your workspace root
3. Open a .tex file
4. Hover over your macro

---

## Generating macro-docs.json from LaTeX
WIP NEED TO EXTEND

This extension is designed to work with a workflow where LaTeX generates documentation automatically.

### Concept

Define your macros with structured documentation:

\MacroDoc{
  command={\PlacePointerArrow},
  signature={\PlacePointerArrow{from=...,to=...,color=...,track=...,style=...,note=...,notepos=...}},
  description={Draws a routed pointer arrow between memory cells.},
  params={
    {from}{0}{Source cell index.},
    {to}{1}{Target cell index.},
    {color}{ptrAarrow}{TikZ colour used for the arrow.},
    {track}{0}{Routing lane number.},
    {style}{flatarc}{Arrow route style.},
    {note}{}{Optional label shown on the arrow.},
    {notepos}{0.5}{Position of the note along the arrow from 0 to 1.}
  }
}

Then during compilation:

\newwrite\macrojson
\immediate\openout\macrojson=macro-docs.json

Write JSON lines using \write, then close at \AtEndDocument.

---

## Optional: LaTeX Workshop integration

You can automate generation and syncing using a custom LaTeX Workshop tool.

Example idea:

{
  "name": "latexmk + docs",
  "tools": [
    "xelatexmk",
    "sync-macro-docs"
  ]
}

Where sync-macro-docs ensures:
- macro-docs.json is written to the workspace root
- it stays in sync with your LaTeX source

---

## Notes

- The JSON file is read on every hover, so no restart is needed
- Works with any custom macros
- Designed to pair with VS Code snippets for full authoring support

---

## Future ideas

- linting invalid macro parameters
- signature validation
- snippet auto-generation