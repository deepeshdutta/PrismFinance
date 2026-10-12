// Publish the navy UI at the site root, with the live data layer injected.
// The previous React app stays reachable as /legacy.html.
import { cpSync, renameSync, readFileSync, writeFileSync } from "node:fs";
renameSync("dist/index.html", "dist/legacy.html");
let html = readFileSync("preview/index.html", "utf8");
const live = readFileSync("live/live.js", "utf8");
const css = "<style>#museUser,.muse-badge{display:none!important}</style>";
html = html.replace("</head>", css + "</head>").replace("</body>", "<script>\n" + live + "\n</script>\n</body>");
writeFileSync("dist/index.html", html);
cpSync("preview/assets", "dist/assets", { recursive: true });
