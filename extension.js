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
 *     "warnings": [...],
 *     "examples": [...],
 *     "params": { ... },
 *     "keys": { ... }
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
 * Parse one named documentation line.
 *
 * This is shared by @param and @key because both use the same shape:
 *
 * With default:
 *   % @param name default=value Description text here.
 *   % @key color default=black Arrow colour.
 *
 * Without default:
 *   % @param name Description text here.
 *   % @key note Optional note text.
 *
 * Quoted defaults are supported:
 *   % @key note default="" Optional label shown on the arrow.
 */
function parseNamedDocLine(line, tagName) {
    const reWithDefault = new RegExp(
        `^%\\s*@${tagName}\\s+(\\S+)\\s+default=(?:"([^"]*)"|(\\S+))\\s*(.*)$`
    );

    let match = line.match(reWithDefault);

    if (match) {
        return {
            name: match[1],
            default: match[2] ?? match[3] ?? "",
            desc: (match[4] ?? "").trim()
        };
    }

    const reWithoutDefault = new RegExp(`^%\\s*@${tagName}\\s+(\\S+)\\s+(.+)$`);
    match = line.match(reWithoutDefault);

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
 * Parse one @param documentation line.
 *
 * Expected formats:
 *   % @param name default=value Description text here.
 *   % @param name Description text here.
 */
function parseParam(line) {
    return parseNamedDocLine(line, "param");
}

/**
 * Parse one @key documentation line.
 *
 * This is for macros that take one key-value argument, e.g.
 *   \PlacePointerArrow{from=1,to=5,track=1}
 *
 * Expected formats:
 *   % @key from default=0 Source cell index.
 *   % @key note Optional note text.
 */
function parseKey(line) {
    return parseNamedDocLine(line, "key");
}

/**
 * Parse all LaTeX Hover documentation blocks in one .tex file.
 *
 * Supported block starts:
 *   % @hover
 *   % @doc
 *   % @lh-doc
 *
 * Supported block ends:
 *   % @endhover
 *   % @enddoc
 *   % @end-lh-doc
 *   % @end
 *
 * Supported lines:
 *   % @command \PlacePointerArrow
 *   % @scope workspace
 *   % @scope file
 *   % @scope files=one.tex,two.tex
 *   % @signature \PlacePointerArrow{from=<cell>, to=<cell>}
 *   % @description Draws a routed pointer arrow.
 *   % @warning Must be called before \DrawMemoryRow.
 *   % @example \PlacePointerArrow{from=1,to=5}
 *   % @param arrow-spec Key-value arrow definition.
 *   % @key from default=0 Source cell index.
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
                warnings: [],
                examples: [],
                params: {},
                keys: {}
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
                    warnings: current.warnings,
                    examples: current.examples,
                    params: current.params,
                    keys: current.keys
                };
            }

            inBlock = false;
            current = null;
            continue;
        }

        let match;

        // Command name used as the lookup key.
        // Examples:
        //   % @command \PlacePointerArrow
        //   % @command \memory_arrow_parse:n
        match = trimmed.match(/^%\s*@command\s+(.+)$/);
        if (match) {
            current.command = match[1].trim();
            continue;
        }

        // Signature shown at the top of the hover popup.
        // Example:
        //   % @signature \PlacePointerArrow{from=<cell>, to=<cell>, ...}
        match = trimmed.match(/^%\s*@signature\s+(.+)$/);
        if (match) {
            current.signature = match[1].trim();
            continue;
        }

        // Human-readable description.
        //
        // Multiple @description lines are joined together with newlines.
        // This lets longer descriptions stay readable in the .tex source.
        match = trimmed.match(/^%\s*@description\s+(.+)$/);
        if (match) {
            const text = match[1].trim();

            if (current.description) {
                current.description += "\n" + text;
            } else {
                current.description = text;
            }

            continue;
        }

        // Warning lines shown in a separate Warnings section.
        // Example:
        //   % @warning Must be called before \DrawMemoryRow.
        match = trimmed.match(/^%\s*@warning\s+(.+)$/);
        if (match) {
            current.warnings.push(match[1].trim());
            continue;
        }

        // Example lines shown as LaTeX code blocks.
        // Example:
        //   % @example \PlacePointerArrow{from=1,to=5}
        match = trimmed.match(/^%\s*@example\s+(.+)$/);
        if (match) {
            current.examples.push(match[1].trim());
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
            continue;
        }

        // Key-value option documentation.
        const key = parseKey(trimmed);
        if (key) {
            current.keys[key.name] = {
                default: key.default,
                desc: key.desc
            };
            continue;
        }
    }

    return docs;
}

/**
 * Generate .documentation-hover/docs.json from documentation blocks
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
 *   {@fn \MacroName}   inline code
 *   {\fn \MacroName}   inline code
 */
function formatDocText(text) {
    return String(text ?? "")
        .replace(/\{@?fn\s+([^}]+)\}/g, "`$1`");
}

/**
 * Check whether an item has a meaningful default.
 *
 * Empty string means "no default provided".
 */
function hasDefault(item) {
    return typeof item !== "string" && item.default !== undefined && item.default !== "";
}

/**
 * Append parameter and key documentation as a single structured table.
 *
 * Params and Keys are rendered within one table so VS Code uses a shared
 * column layout. This keeps the Description column aligned.
 *
 * Table behaviour:
 * - If Params exist, the first column header is "Param"
 * - If no Params exist, the first column header is "Key"
 *
 * When both Params and Keys exist:
 * - Param rows are shown first
 * - A header-style divider row is inserted for Keys
 *   (Key | Default | Description)
 * - Key rows follow
 *
 * The Default column is shared across the entire table:
 * - shown if any Param or Key has a default
 * - hidden if none have defaults
 */
function appendDocsTable(md, params, keys) {
    const paramEntries = Object.entries(params || {});
    const keyEntries = Object.entries(keys || {});

    if (paramEntries.length === 0 && keyEntries.length === 0) {
        return;
    }

    const allEntries = [...paramEntries, ...keyEntries];
    const showDefaultColumn = allEntries.some(([, item]) => hasDefault(item));

    const firstColumnName = paramEntries.length > 0 ? "Param" : "Key";

    if (showDefaultColumn) {
        md.appendMarkdown(`\n| ${firstColumnName} | Default | Description |\n|:------|:--------|:------------|\n`);
    } else {
        md.appendMarkdown(`\n| ${firstColumnName} | Description |\n|:------|:------------|\n`);
    }

    for (const [name, item] of paramEntries) {
        appendDocRow(md, name, item, showDefaultColumn);
    }

    if (paramEntries.length > 0 && keyEntries.length > 0) {
        if (showDefaultColumn) {
            md.appendMarkdown("| **Key** | **Default** | **Description** |\n");
        } else {
            md.appendMarkdown("| **Key** | **Description** |\n");
        }
    }

    for (const [name, item] of keyEntries) {
        appendDocRow(md, name, item, showDefaultColumn);
    }
}

function appendDocRow(md, name, item, showDefaultColumn) {
    const desc = typeof item === "string"
        ? escapeTableCell(formatDocText(item))
        : escapeTableCell(formatDocText(item.desc || ""));

    const def = typeof item === "string"
        ? ""
        : hasDefault(item)
            ? `\`${escapeTableCell(item.default)}\``
            : "";

    if (showDefaultColumn) {
        md.appendMarkdown(`| \`${escapeTableCell(name)}\` | ${def} | ${desc} |\n`);
    } else {
        md.appendMarkdown(`| \`${escapeTableCell(name)}\` | ${desc} |\n`);
    }
}

/**
 * Append one documentation table for either Params or Keys.
 */
function appendSingleDocTable(md, entries, nameColumn, showDefaultColumn) {
    if (entries.length === 0) {
        return;
    }

    if (showDefaultColumn) {
        md.appendMarkdown(`\n| ${nameColumn} | Default | Description |\n|:------|:--------|:------------|\n`);
    } else {
        md.appendMarkdown(`\n| ${nameColumn} | Description |\n|:------|:------------|\n`);
    }

    for (const [name, item] of entries) {
        const desc = typeof item === "string"
            ? escapeTableCell(formatDocText(item))
            : escapeTableCell(formatDocText(item.desc || ""));

        const def = typeof item === "string"
            ? ""
            : hasDefault(item)
                ? `\`${escapeTableCell(item.default)}\``
                : "";

        if (showDefaultColumn) {
            md.appendMarkdown(`| \`${escapeTableCell(name)}\` | ${def} | ${desc} |\n`);
        } else {
            md.appendMarkdown(`| \`${escapeTableCell(name)}\` | ${desc} |\n`);
        }
    }
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

    // Optional warning section.
    //
    // VS Code hover markdown does not support custom CSS/background colours.
    // A blockquote gives the warning a visibly different shaded style in most themes.
    if (Array.isArray(entry.warnings) && entry.warnings.length > 0) {
        //md.appendMarkdown("\n**Warnings**\n\n");
        md.appendMarkdown("\n");

        for (const warning of entry.warnings) {
            md.appendMarkdown(`\n\`! ${escapeTableCell(formatDocText(warning))}\`\n`);
        }
    }

    // Optional parameter and key table.
    appendDocsTable(md, entry.params, entry.keys);

    // Optional example section.
    //
    // Examples are rendered as code blocks so they are visually separate and easy to copy.
    if (Array.isArray(entry.examples) && entry.examples.length > 0) {
        md.appendMarkdown("\n**Examples**\n");

        for (const example of entry.examples) {
            md.appendCodeblock(example, "latex");
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
            // This now supports:
            //   \PlacePointerArrow
            //   \DrawMemoryRow
            //   \some@internal
            //   \memory_arrow_parse:n
            const range = document.getWordRangeAtPosition(position, /\\[A-Za-z@:_]+/);

            // If the cursor is not over a LaTeX command, do not show anything.
            if (!range) {
                return null;
            }

            const command = document.getText(range);

            // Load the docs every hover.
            // This keeps the extension simple and means changes to docs.json
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

    // Command Palette command for manually generating docs.json.
    const generateCommand = vscode.commands.registerCommand(
        "latex-documentation-hover.generateMacroDocs",
        generateMacroDocs
    );

    // Automatically regenerate docs.json whenever a LaTeX file is saved.
    //
    // This means the normal workflow becomes:
    //   edit @hover block
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