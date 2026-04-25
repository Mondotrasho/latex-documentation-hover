const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

/**
 * Load macro documentation from the current workspace.
 *
 * Expected file location:
 *   <workspace root>/macro-docs.json
 *
 * The file should map LaTeX command names to documentation entries, e.g.
 * {
 *   "\\PlacePointerArrow": {
 *     "signature": "...",
 *     "description": "...",
 *     "params": { ... }
 *   }
 * }
 */
function loadDocs() {
    const folders = vscode.workspace.workspaceFolders;

    // No open folder means there is no workspace root to search from.
    if (!folders || folders.length === 0) {
        return {};
    }

    // For now, use the first workspace folder.
    // This is enough for normal single-folder projects.
    const root = folders[0].uri.fsPath;
    const docsPath = path.join(root, "macro-docs.json");

    // If the docs file does not exist, silently do nothing.
    if (!fs.existsSync(docsPath)) {
        return {};
    }

    // Read and parse the documentation file.
    // If the JSON is broken, fail safely instead of breaking hover.
    try {
        return JSON.parse(fs.readFileSync(docsPath, "utf8"));
    } catch (err) {
        console.error("Failed to read macro-docs.json:", err);
        return {};
    }
}

/**
 * Called by VS Code when the extension activates.
 *
 * The activation event is defined in package.json, usually:
 *   "activationEvents": ["onLanguage:latex"]
 */
function activate(context) {
    const provider = vscode.languages.registerHoverProvider("latex", {
        provideHover(document, position) {
            // Find the LaTeX command under the cursor.
            // This matches commands like:
            //   \PlacePointerArrow
            //   \DrawMemoryRow
            //   \some@internal
            const range = document.getWordRangeAtPosition(position, /\\[A-Za-z@]+/);

            // If the cursor is not over a LaTeX command, do not show anything.
            if (!range) {
                return null;
            }

            const command = document.getText(range);

            // Load the docs every hover.
            // This keeps the extension simple and means changes to macro-docs.json
            // are picked up without restarting VS Code.
            const docs = loadDocs();
            const entry = docs[command];

            // No matching documentation entry means no custom hover.
            if (!entry) {
                return null;
            }

            // Build the hover content as Markdown.
            const md = new vscode.MarkdownString();

            // Show the macro signature first as a LaTeX code block.
            md.appendCodeblock(entry.signature || command, "latex");

            // Optional short explanation of what the macro does.
            if (entry.description) {
                md.appendMarkdown(`\n${entry.description}\n`);
            }

            // Optional parameter table.
            //
            // Supports two formats:
            //
            // 1. Simple string:
            //    "from": "Source cell index."
            //
            // 2. Structured object:
            //    "from": {
            //      "default": "0",
            //      "desc": "Source cell index."
            //    }
            if (entry.params) {
                md.appendMarkdown("\n| Param | Default | Description |\n|------|---------|-------------|\n");

                for (const [name, param] of Object.entries(entry.params)) {
                    if (typeof param === "string") {
                        // Old/simple format: param value is just the description.
                        md.appendMarkdown(`| \`${name}\` |  | ${param} |\n`);
                    } else {
                        // New/structured format: param has default and description fields.
                        const desc = param.desc || "";
                        const def = param.default ?? "";

                        md.appendMarkdown(`| \`${name}\` | \`${def}\` | ${desc} |\n`);
                    }
                }
            }

            // Return the hover popup, attached to the matched command range.
            return new vscode.Hover(md, range);
        }
    });

    // Register the provider so VS Code can clean it up when the extension unloads.
    context.subscriptions.push(provider);
}

/**
 * Called when the extension is deactivated.
 * Nothing needed here because subscriptions are cleaned up automatically.
 */
function deactivate() {}

module.exports = {
    activate,
    deactivate
};