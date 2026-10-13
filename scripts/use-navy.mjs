// Publish the navy UI at the site root, with the live data layer injected.
// The previous React app stays reachable as /legacy.html.
import { cpSync, renameSync, readFileSync, writeFileSync } from "node:fs";
renameSync("dist/index.html", "dist/legacy.html");
let html = readFileSync("preview/index.html", "utf8");
const live = readFileSync("live/live.js", "utf8");
const ticker = readFileSync("live/ticker.js", "utf8");
const css = "<style>#museUser,.muse-badge{display:none!important}</style>";
html = html.replace("</head>", css + "</head>").replace("</body>", "<script>window.PRISM_TICKER={url:'/api/ticker',mode:'member'};\n" + ticker + "\n</script>\n<script>\n" + live + "\n</script>\n</body>");
writeFileSync("dist/index.html", html);
cpSync("preview/assets", "dist/assets", { recursive: true });

// Public logged-out page: generic prices only, same bar.
const pub = readFileSync("live/markets.html", "utf8").replace("/*TICKER*/", () => "window.PRISM_TICKER={url:'/public/quotes',mode:'public'};\n" + ticker);
writeFileSync("dist/markets.html", pub);
