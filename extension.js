const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const DOCS_DIR = ".documentation-hover";
const DOCS_FILE = "docs.json";

/**
 * Get the current workspace root.
 *
 * For now, this uses the first workspace folder.
 * This is enough for normal single-folder projects.
 */
function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;

    // No open folder means there is no workspace root to search from.
    if (!folders || folders.length === 0) {
        return null;
    }

    return folders[0].uri.fsPath;
}

/**
 * Get the full path to the generated documentation JSON file.
 *
 * Expected location:
 *   <workspace root>/.documentation-hover/docs.json
 */
function getDocsPath() {
    const root = getWorkspaceRoot();

    if (!root) {
        return null;
    }

    return path.join(root, DOCS_DIR, DOCS_FILE);
}

/**
 * Convert an absolute file path into a workspace-relative path.
 *
 * This is used for source tracking and file-scoped documentation.
 */
function makeRelativeToWorkspace(filePath) {
    const root = getWorkspaceRoot();

    if (!root) {
        return filePath;
    }

    return path.relative(root, filePath).replace(/\\/g, "/");
}

/**
 * Load macro documentation from the current workspace.
 *
 * Expected file location:
*   <workspace root>/.documentation-hover/docs.json
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
    const docsPath = getDocsPath();

    if (!docsPath) {
        return {};
    }

    // If the docs file does not exist, silently do nothing.
    if (!fs.existsSync(docsPath)) {
        return {};
    }

    // Read and parse the documentation file.
    // If the JSON is broken, fail safely instead of breaking hover.
    try {
        return JSON.parse(fs.readFileSync(docsPath, "utf8"));
    } catch (err) {
        console.error(`Failed to read ${docsPath}:`, err);
        return {};
    }
}

/**
 * Check whether a documentation entry is allowed for the current file.
 *
 * Supported scopes:
 *
 * workspace:
 *   available in all .tex files
 *
 * file:
 *   available only in the file where the doc block was found
 *
 * files:
 *   available only in explicitly listed files
 */
function scopeMatches(entry, document) {
    // No scope means workspace-wide by default.
    if (!entry.scope || entry.scope.type === "workspace") {
        return true;
    }

    const currentFile = makeRelativeToWorkspace(document.uri.fsPath);

    if (entry.scope.type === "file") {
        return entry.source === currentFile;
    }

    if (entry.scope.type === "files") {
        return Array.isArray(entry.scope.files) && entry.scope.files.includes(currentFile);
    }

    // Unknown scopes fail open for now.
    return true;
}

/**
 * Parse one @param documentation line.
 *
 * Expected format:
 *   % @param name default=value Description text here.
 *
 * Examples:
 *   % @param from default=0 Source cell index.
 *   % @param note default="" Optional label shown on the arrow.
 */
function parseParam(line) {
    // Format with default:
    // % @param from default=0 Source cell index.
    let match = line.match(/^%\s*@param\s+(\S+)\s+default=(?:"([^"]*)"|(\S+))\s*(.*)$/);

    if (match) {
        return {
            name: match[1],
            default: match[2] ?? match[3] ?? "",
            desc: (match[4] ?? "").trim()
        };
    }

    // Format without default:
    // % @param from Source cell index.
    match = line.match(/^%\s*@param\s+(\S+)\s+(.+)$/);

    if (match) {
        return {
            name: match[1],
            default: "",
            desc: match[2].trim()
        };
    }

    return null;
}

/**
 * Parse all LaTeX Hover documentation blocks in one .tex file.
 *
 * Expected block format:
 *
 * % @lh-doc
 * % @command \PlacePointerArrow
 * % @scope workspace
 * % @signature \PlacePointerArrow{from=...,to=...}
 * % @description Draws a routed pointer arrow.
 * % @param from default=0 Source cell index.
 * % @end-lh-doc
 */
function parseDocBlocks(text, sourceFile) {
    const docs = {};
    const lines = text.split(/\r?\n/);

    let inBlock = false;
    let current = null;

    for (const line of lines) {
        const trimmed = line.trim();

        // Start a new documentation block.
        if (/^%\s*@(?:lh-doc|hover|doc)\s*$/.test(trimmed)) {
            inBlock = true;
            current = {
                source: sourceFile,
                scope: { type: "workspace" },
                signature: "",
                description: "",
                params: {}
            };
            continue;
        }

        // Ignore all lines outside a documentation block.
        if (!inBlock || !current) {
            continue;
        }

        // Finish the current documentation block.
        if (/^%\s*@(?:end-lh-doc|endhover|enddoc|end)\s*$/.test(trimmed)) {
            if (current.command) {
                docs[current.command] = {
                    source: current.source,
                    scope: current.scope,
                    signature: current.signature,
                    description: current.description,
                    params: current.params
                };
            }

            inBlock = false;
            current = null;
            continue;
        }

        let match;

        // Command name used as the lookup key.
        // Example:
        //   % @command \PlacePointerArrow
        match = trimmed.match(/^%\s*@command\s+(.+)$/);
        if (match) {
            current.command = match[1].trim();
            continue;
        }

        // Signature shown at the top of the hover popup.
        match = trimmed.match(/^%\s*@signature\s+(.+)$/);
        if (match) {
            current.signature = match[1].trim();
            continue;
        }

        // Short human-readable description.
        match = trimmed.match(/^%\s*@description\s+(.+)$/);
        if (match) {
            current.description = match[1].trim();
            continue;
        }

        // Scope controls where the generated hover entry applies.
        //
        // Supported:
        //   % @scope workspace
        //   % @scope file
        //   % @scope files=one.tex,two.tex
        match = trimmed.match(/^%\s*@scope\s+(.+)$/);
        if (match) {
            const rawScope = match[1].trim();

            if (rawScope === "workspace") {
                current.scope = { type: "workspace" };
            } else if (rawScope === "file") {
                current.scope = { type: "file" };
            } else if (rawScope.startsWith("files=")) {
                const files = rawScope
                    .slice("files=".length)
                    .split(",")
                    .map(s => s.trim().replace(/\\/g, "/"))
                    .filter(Boolean);

                current.scope = { type: "files", files };
            }

            continue;
        }

        // Parameter documentation.
        const param = parseParam(trimmed);
        if (param) {
            current.params[param.name] = {
                default: param.default,
                desc: param.desc
            };
        }
    }

    return docs;
}

/**
 * Generate .documentation-hover/docs.json from @lh-doc blocks
 * in all workspace .tex files.
 *
 * This is exposed as a VS Code command:
 *   LaTeX Documentation Hover: Generate docs.json
 */
async function generateMacroDocs() {
    const root = getWorkspaceRoot();

    if (!root) {
        vscode.window.showWarningMessage("No workspace folder is open.");
        return;
    }

    // Search all .tex files in the workspace, ignoring common generated/vendor folders.
    const texFiles = await vscode.workspace.findFiles("**/*.tex", "**/{.git,node_modules}/**");
    const allDocs = {};

    for (const uri of texFiles) {
        const filePath = uri.fsPath;
        const sourceFile = makeRelativeToWorkspace(filePath);
        const text = fs.readFileSync(filePath, "utf8");

        Object.assign(allDocs, parseDocBlocks(text, sourceFile));
    }

    const docsDir = path.join(root, DOCS_DIR);

    if (!fs.existsSync(docsDir)) {
        fs.mkdirSync(docsDir, { recursive: true });
    }
    
    const outPath = path.join(docsDir, DOCS_FILE);

    // JSON.stringify handles all the escaping that is annoying to do in LaTeX.
    fs.writeFileSync(outPath, JSON.stringify(allDocs, null, 2), "utf8");

    vscode.window.showInformationMessage(
        `Generated ${DOCS_DIR}/${DOCS_FILE} with ${Object.keys(allDocs).length} entries.`
    );
}

/**
 * Escape text for safe use inside a Markdown table cell.
 */
function escapeTableCell(value) {
    return String(value ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\r?\n/g, " ");
}

/**
 * Apply simple inline formatting to documentation text.
 *
 * Supported:
 *   `\MacroName`       inline code
 *   {\fn \MacroName}   inline code
 *   {@fn \MacroName}   inline code
 */
function formatDocText(text) {
    return String(text ?? "")
        .replace(/\{@?fn\s+([^}]+)\}/g, "`$1`");
}

/**
 * Check whether a param has a meaningful default.
 *
 * Empty string means "no default provided".
 */
function hasDefault(param) {
    return typeof param !== "string" && param.default !== undefined && param.default !== "";
}

/**
 * Build the markdown shown in the hover popup.
 */
function buildHover(entry, command) {
    const md = new vscode.MarkdownString();

    // Show the macro signature first as a LaTeX code block.
    md.appendCodeblock(entry.signature || command, "latex");

    // Optional short explanation of what the macro does.
    if (entry.description) {
        md.appendMarkdown(`\n${formatDocText(entry.description)}\n`);
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
        const params = Object.entries(entry.params);
        const showDefaultColumn = params.some(([, param]) => hasDefault(param));

        if (showDefaultColumn) {
            md.appendMarkdown("\n| Param | Default | Description |\n|:------|:--------|:------------|\n");
        } else {
            md.appendMarkdown("\n| Param | Description |\n|:------|:------------|\n");
        }

        for (const [name, param] of params) {
            if (typeof param === "string") {
                const desc = escapeTableCell(formatDocText(param));

                if (showDefaultColumn) {
                    md.appendMarkdown(`| \`${escapeTableCell(name)}\` |  | ${desc} |\n`);
                } else {
                    md.appendMarkdown(`| \`${escapeTableCell(name)}\` | ${desc} |\n`);
                }
            } else {
                const desc = escapeTableCell(formatDocText(param.desc || ""));
                const def = hasDefault(param) ? `\`${escapeTableCell(param.default)}\`` : "";

                if (showDefaultColumn) {
                    md.appendMarkdown(`| \`${escapeTableCell(name)}\` | ${def} | ${desc} |\n`);
                } else {
                    md.appendMarkdown(`| \`${escapeTableCell(name)}\` | ${desc} |\n`);
                }
            }
        }
    }

    return md;
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

            // Respect file/workspace scope before showing hover docs.
            if (!scopeMatches(entry, document)) {
                return null;
            }

            // Return the hover popup, attached to the matched command range.
            return new vscode.Hover(buildHover(entry, command), range);
        }
    });

    // Command Palette command for manually generating macro-docs.json.
    const generateCommand = vscode.commands.registerCommand(
        "latex-documentation-hover.generateMacroDocs",
        generateMacroDocs
    );

    // Automatically regenerate macro-docs.json whenever a LaTeX file is saved.
    //
    // This means the normal workflow becomes:
    //   edit @lh-doc block
    //   save .tex file
    //   hover docs update automatically
    const saveWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.languageId === "latex" || document.fileName.endsWith(".tex")) {
            generateMacroDocs();
        }
    });

    // Register the provider, command and save watcher so VS Code can clean them up
    // when the extension unloads.
    context.subscriptions.push(provider, generateCommand, saveWatcher);
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